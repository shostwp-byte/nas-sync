import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { acquireServerLock } from '@/lib/engine/queue';
import { applyGfsRetentionForServer } from '@/lib/engine/retention-gfs';

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const serverId = Number(body.serverId);
    const dryRun = Boolean(body.dryRun);
    const rawPolicy = body.policy || { daily: 7, weekly: 4, monthly: 6 };

    if (!dryRun && guard.session.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Thao tác này yêu cầu quyền Quản trị viên (ADMIN).' },
        { status: 403 }
      );
    }

    if (!Number.isInteger(serverId) || serverId <= 0) {
      return NextResponse.json(
        { error: 'Vui lòng chọn máy chủ để kiểm tra/chạy chính sách GFS.' },
        { status: 400 }
      );
    }

    const daily = Number(rawPolicy.daily ?? 7);
    const weekly = Number(rawPolicy.weekly ?? 4);
    const monthly = Number(rawPolicy.monthly ?? 6);
    if (
      !Number.isInteger(daily) ||
      daily < 1 ||
      daily > 3650 ||
      !Number.isInteger(weekly) ||
      weekly < 0 ||
      weekly > 520 ||
      !Number.isInteger(monthly) ||
      monthly < 0 ||
      monthly > 240
    ) {
      return NextResponse.json(
        {
          error:
            'Chính sách lưu trữ GFS không hợp lệ (Daily >= 1, Weekly >= 0, Monthly >= 0).',
        },
        { status: 400 }
      );
    }

    const policy = { daily, weekly, monthly };

    if (dryRun) {
      const result = await applyGfsRetentionForServer(serverId, policy, true);
      return NextResponse.json({ ok: true, ...result });
    }

    const release = await acquireServerLock(serverId);
    try {
      const result = await applyGfsRetentionForServer(serverId, policy, false);
      const srv = getDb()
        .prepare('SELECT hostname FROM servers WHERE id = ?')
        .get(serverId);

      recordAuditLog({
        session: guard.session,
        action: 'RETENTION_PURGE',
        resourceType: 'SERVER',
        resourceId: String(serverId),
        detail: `Thực thi dọn dẹp GFS trên "${
          srv?.hostname || `Server #${serverId}`
        }" (Daily:${daily}, Weekly:${weekly}, Monthly:${monthly})`,
        req,
      });

      return NextResponse.json({ ok: true, ...result });
    } finally {
      release();
    }
  } catch (err) {
    return safeErrorJson(err, 'Không thể thực thi chính sách lưu trữ GFS.', 500);
  }
}

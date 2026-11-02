import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson, sanitizeErrorMessage } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  startSnapshotOffsitePush,
  testOffsiteConnection,
} from '@/lib/engine/offsite-cloud';
import type { OffsiteSyncJob } from '@/types';

export async function GET() {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
    if (!guard.ok) return guard.response;

    const jobs = getDb()
      .prepare(
        `SELECT
           o.*,
           s.hostname AS server_hostname
         FROM offsite_sync_jobs o
         LEFT JOIN servers s ON s.id = o.server_id
         ORDER BY o.id DESC
         LIMIT 30`
      )
      .all() as unknown as OffsiteSyncJob[];

    return NextResponse.json({ jobs });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể tải lịch sử đồng bộ Offsite Cloud.'
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '').trim();

    if (action === 'test_connection') {
      const guard = await requireRole(['ADMIN']);
      if (!guard.ok) return guard.response;

      const rawOverrides =
        body.overrides && typeof body.overrides === 'object'
          ? (body.overrides as Record<string, string>)
          : undefined;

      try {
        const res = await testOffsiteConnection(rawOverrides);
        return NextResponse.json({
          ok: true,
          providerLabel: res.providerLabel,
          detail: res.detail,
        });
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            error: sanitizeErrorMessage(
              err,
              'Kiểm tra kết nối Offsite Cloud thất bại.'
            ),
          },
          { status: 400 }
        );
      }
    }

    if (action === 'push_snapshot') {
      const guard = await requireRole(['ADMIN', 'OPERATOR']);
      if (!guard.ok) return guard.response;

      const jobId = Number(body.jobId);
      if (!Number.isInteger(jobId) || jobId <= 0) {
        return NextResponse.json(
          { error: 'Tham số jobId không hợp lệ.' },
          { status: 400 }
        );
      }

      const { offsiteJobId, completion } = startSnapshotOffsitePush(jobId, {
        triggerSource: `MANUAL:${guard.session.username}`,
      });

      // Chạy tải lên nền để HTTP phản hồi ngay lập tức
      void completion.catch((err) => {
        console.warn(
          `[Offsite Manual Push #${offsiteJobId} Error]:`,
          (err as Error).message
        );
      });

      recordAuditLog({
        session: guard.session,
        action: 'OFFSITE_PUSH_SNAPSHOT',
        resourceType: 'SNAPSHOT',
        resourceId: String(jobId),
        detail: `Kích hoạt đẩy thủ công Snapshot (Backup Job #${jobId}) lên Offsite Cloud (Offsite Job #${offsiteJobId})`,
        req,
      });

      return NextResponse.json({
        ok: true,
        offsiteJobId,
      });
    }

    return NextResponse.json(
      { error: 'Hành động Offsite API không hợp lệ.' },
      { status: 400 }
    );
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể thực hiện thao tác Offsite Cloud Backup.'
    );
  }
}

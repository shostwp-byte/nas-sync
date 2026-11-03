import cron from 'node-cron';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { reloadCronSchedules } from '@/lib/engine/queue';

export async function GET() {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
    if (!guard.ok) return guard.response;

    const rows = getDb()
      .prepare('SELECT * FROM backup_schedules ORDER BY id DESC')
      .all();

    const schedules = rows.map((r) => ({
      ...r,
      server_ids: JSON.parse(String(r.server_ids || '[]')),
      retention_policy: JSON.parse(
        String(r.retention_policy || '{"daily":7,"weekly":4,"monthly":6}')
      ),
      verify_db_sandbox: Number(r.verify_db_sandbox) === 1,
      btrfs_snapshot_after: Number(r.btrfs_snapshot_after) === 1,
      enabled: Number(r.enabled) === 1,
    }));

    return NextResponse.json({ schedules });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải danh sách lịch sao lưu.', 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const name = String(body.name || '').trim();
    const cronExp = String(body.cron_expression || '0 1 * * *').trim();

    if (!name) {
      return NextResponse.json(
        { error: 'Vui lòng nhập tên lịch chạy.' },
        { status: 400 }
      );
    }

    if (!cron.validate(cronExp)) {
      return NextResponse.json(
        { error: `Biểu thức Cron "${cronExp}" không hợp lệ.` },
        { status: 400 }
      );
    }

    const serverIds = Array.isArray(body.server_ids)
      ? Array.from(
          new Set(
            body.server_ids
              .map((v: unknown) => Number(v))
              .filter((n: number) => Number.isInteger(n) && n > 0)
          )
        )
      : [];

    if (serverIds.length === 0) {
      return NextResponse.json(
        { error: 'Vui lòng chọn ít nhất 1 máy chủ cho lịch sao lưu.' },
        { status: 400 }
      );
    }

    const maxConcurrency = Number(body.max_concurrency ?? 2);
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 10
    ) {
      return NextResponse.json(
        {
          error:
            'Số luồng chạy đồng thời (max_concurrency) phải là số nguyên từ 1 đến 10.',
        },
        { status: 400 }
      );
    }

    const rawRetention = body.retention_policy || {
      daily: 7,
      weekly: 4,
      monthly: 6,
    };
    const daily = Number(rawRetention.daily ?? 7);
    const weekly = Number(rawRetention.weekly ?? 4);
    const monthly = Number(rawRetention.monthly ?? 6);
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
    const retention = { daily, weekly, monthly };
    const verifyDb = body.verify_db_sandbox !== false ? 1 : 0;
    const btrfsAfter = body.btrfs_snapshot_after ? 1 : 0;
    const enabled = body.enabled !== false ? 1 : 0;

    const ins = getDb()
      .prepare(
        `INSERT INTO backup_schedules
         (name, cron_expression, server_ids, max_concurrency, retention_policy, verify_db_sandbox, btrfs_snapshot_after, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name,
        cronExp,
        JSON.stringify(serverIds),
        maxConcurrency,
        JSON.stringify(retention),
        verifyDb,
        btrfsAfter,
        enabled
      );

    reloadCronSchedules();
    recordAuditLog({
      session: guard.session,
      action: 'SCHEDULE_CREATE',
      resourceType: 'SCHEDULE',
      resourceId: String(ins.lastInsertRowid),
      detail: `Tạo lịch sao lưu tự động "${name}" (${cronExp}, ${serverIds.length} VPS)`,
      req,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tạo lịch sao lưu mới.', 500);
  }
}


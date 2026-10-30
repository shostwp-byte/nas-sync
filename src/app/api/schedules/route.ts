import cron from 'node-cron';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { reloadCronSchedules } from '@/lib/engine/queue';

export async function GET() {
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
}

export async function POST(req: NextRequest) {
  try {
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
      ? body.server_ids.map(Number)
      : [];
    const maxConcurrency = Number(body.max_concurrency || 2);
    const retention = body.retention_policy || {
      daily: 7,
      weekly: 4,
      monthly: 6,
    };
    const verifyDb = body.verify_db_sandbox !== false ? 1 : 0;
    const btrfsAfter = body.btrfs_snapshot_after ? 1 : 0;
    const enabled = body.enabled !== false ? 1 : 0;

    getDb()
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
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


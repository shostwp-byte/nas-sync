import cron from 'node-cron';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  enqueueServerBackup,
  reloadCronSchedules,
} from '@/lib/engine/queue';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const db = getDb();
    const curr = db
      .prepare('SELECT * FROM backup_schedules WHERE id = ?')
      .get(Number(id));

    if (!curr) {
      return NextResponse.json(
        { error: 'Không tìm thấy lịch sao lưu.' },
        { status: 404 }
      );
    }

    const nextCron = String(body.cron_expression ?? curr.cron_expression).trim();
    if (!cron.validate(nextCron)) {
      return NextResponse.json(
        { error: `Biểu thức Cron "${nextCron}" không hợp lệ.` },
        { status: 400 }
      );
    }

    db.prepare(
      `UPDATE backup_schedules
       SET name = ?, cron_expression = ?, server_ids = ?, max_concurrency = ?,
           retention_policy = ?, verify_db_sandbox = ?, btrfs_snapshot_after = ?, enabled = ?
       WHERE id = ?`
    ).run(
      body.name ?? curr.name,
      nextCron,
      body.server_ids ? JSON.stringify(body.server_ids) : curr.server_ids,
      Number(body.max_concurrency ?? curr.max_concurrency),
      body.retention_policy
        ? JSON.stringify(body.retention_policy)
        : curr.retention_policy,
      body.verify_db_sandbox !== undefined
        ? body.verify_db_sandbox
          ? 1
          : 0
        : curr.verify_db_sandbox,
      body.btrfs_snapshot_after !== undefined
        ? body.btrfs_snapshot_after
          ? 1
          : 0
        : curr.btrfs_snapshot_after,
      body.enabled !== undefined ? (body.enabled ? 1 : 0) : curr.enabled,
      Number(id)
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

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDb();
    const sched = db
      .prepare('SELECT * FROM backup_schedules WHERE id = ?')
      .get(Number(id));
    if (!sched) {
      return NextResponse.json(
        { error: 'Không tìm thấy lịch chạy.' },
        { status: 404 }
      );
    }

    const serverIds: number[] = JSON.parse(String(sched.server_ids || '[]'));
    const retention = JSON.parse(
      String(sched.retention_policy || '{"daily":7,"weekly":4,"monthly":6}')
    );

    const jobIds: number[] = [];
    for (const sid of serverIds) {
      const jid = await enqueueServerBackup({
        serverId: sid,
        scheduleId: Number(id),
        verifyDb: Number(sched.verify_db_sandbox) === 1,
        retentionPolicy: retention,
      });
      jobIds.push(jid);
    }

    db.prepare(
      `UPDATE backup_schedules SET last_run_at = datetime('now') WHERE id = ?`
    ).run(Number(id));

    return NextResponse.json({ ok: true, jobIds });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  getDb().prepare('DELETE FROM backup_schedules WHERE id = ?').run(Number(id));
  reloadCronSchedules();
  return NextResponse.json({ ok: true });
}


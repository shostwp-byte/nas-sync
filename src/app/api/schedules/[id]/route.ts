import cron from 'node-cron';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
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
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

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

    const nextName =
      body.name !== undefined ? String(body.name).trim() : String(curr.name);
    if (!nextName || nextName.length > 128) {
      return NextResponse.json(
        { error: 'Tên lịch sao lưu không hợp lệ (1-128 ký tự).' },
        { status: 400 }
      );
    }

    const nextCron = String(body.cron_expression ?? curr.cron_expression).trim();
    if (!cron.validate(nextCron)) {
      return NextResponse.json(
        { error: `Biểu thức Cron "${nextCron}" không hợp lệ.` },
        { status: 400 }
      );
    }

    let nextServerIdsJson = String(curr.server_ids || '[]');
    if (body.server_ids !== undefined) {
      const parsedIds = Array.isArray(body.server_ids)
        ? Array.from(
            new Set(
              body.server_ids
                .map((v: unknown) => Number(v))
                .filter((n: number) => Number.isInteger(n) && n > 0)
            )
          )
        : [];
      if (parsedIds.length === 0) {
        return NextResponse.json(
          { error: 'Vui lòng chọn ít nhất 1 máy chủ cho lịch sao lưu.' },
          { status: 400 }
        );
      }
      nextServerIdsJson = JSON.stringify(parsedIds);
    }

    const nextMaxConcurrency = Number(
      body.max_concurrency ?? curr.max_concurrency
    );
    if (
      !Number.isInteger(nextMaxConcurrency) ||
      nextMaxConcurrency < 1 ||
      nextMaxConcurrency > 10
    ) {
      return NextResponse.json(
        {
          error:
            'Số luồng chạy đồng thời (max_concurrency) phải là số nguyên từ 1 đến 10.',
        },
        { status: 400 }
      );
    }

    let nextRetentionJson = String(
      curr.retention_policy || '{"daily":7,"weekly":4,"monthly":6}'
    );
    if (body.retention_policy !== undefined) {
      const rawRet = body.retention_policy || {};
      const daily = Number(rawRet.daily);
      const weekly = Number(rawRet.weekly);
      const monthly = Number(rawRet.monthly);
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
      nextRetentionJson = JSON.stringify({ daily, weekly, monthly });
    }

    db.prepare(
      `UPDATE backup_schedules
       SET name = ?, cron_expression = ?, server_ids = ?, max_concurrency = ?,
           retention_policy = ?, verify_db_sandbox = ?, btrfs_snapshot_after = ?, enabled = ?
       WHERE id = ?`
    ).run(
      nextName,
      nextCron,
      nextServerIdsJson,
      nextMaxConcurrency,
      nextRetentionJson,
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
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

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
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  getDb().prepare('DELETE FROM backup_schedules WHERE id = ?').run(Number(id));
  reloadCronSchedules();
  return NextResponse.json({ ok: true });
}


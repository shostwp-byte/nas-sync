import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveSafeSnapshotRoot } from '@/lib/engine/explorer';
import {
  cancelRunningOrQueuedJob,
  dispatchExistingJob,
} from '@/lib/engine/queue';
import { verifyJobDatabasesInSandbox } from '@/lib/engine/sandbox-verifier';
import { resolveLatestSnapshotDir } from '@/lib/engine/volume-manager';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const job = db
    .prepare(
      `SELECT
         j.*,
         s.hostname AS server_hostname,
         s.panel_type AS server_panel,
         ts.hostname AS target_server_hostname,
         v.name AS volume_name,
         v.mount_path AS volume_mount_path
       FROM backup_jobs j
       LEFT JOIN servers s ON s.id = j.server_id
       LEFT JOIN servers ts ON ts.id = j.target_server_id
       LEFT JOIN storage_volumes v ON v.id = j.volume_id
       WHERE j.id = ?`
    )
    .get(Number(id));

  if (!job) {
    return NextResponse.json({ error: 'Không tìm thấy Job.' }, { status: 404 });
  }

  const rawItems = db
    .prepare('SELECT * FROM backup_items WHERE job_id = ? ORDER BY domain_name ASC')
    .all(Number(id));

  const items = rawItems.map((it) => ({
    ...it,
    databases_list: JSON.parse(String(it.databases_list || '[]')),
  }));

  return NextResponse.json({ job, items });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const jobId = Number(id);
    const body = await req.json();
    const action = String(body.action || '');
    const db = getDb();

    const job = db
      .prepare('SELECT * FROM backup_jobs WHERE id = ?')
      .get(jobId);
    if (!job) {
      return NextResponse.json(
        { error: 'Không tìm thấy Job.' },
        { status: 404 }
      );
    }

    if (action === 'pin' || action === 'unpin') {
      const pinVal = action === 'pin' ? 1 : 0;
      db.prepare('UPDATE backup_jobs SET is_pinned = ? WHERE id = ?').run(
        pinVal,
        jobId
      );
      db.prepare('UPDATE backup_items SET is_pinned = ? WHERE job_id = ?').run(
        pinVal,
        jobId
      );
      return NextResponse.json({ ok: true, is_pinned: pinVal });
    }

    if (action === 'cancel') {
      cancelRunningOrQueuedJob(jobId);
      return NextResponse.json({ ok: true });
    }

    if (action === 'retry') {
      db.prepare(
        `UPDATE backup_jobs SET status = 'QUEUED', current_phase = 'Đang xếp hàng thử lại...', error_log = NULL WHERE id = ?`
      ).run(jobId);
      await dispatchExistingJob(
        jobId,
        String(job.job_type) === 'RESTORE' ? 'RESTORE' : 'BACKUP'
      );
      return NextResponse.json({ ok: true });
    }

    if (action === 'verify_sandbox') {
      const { snapshotRoot } = resolveSafeSnapshotRoot(jobId);
      const summary = await verifyJobDatabasesInSandbox(
        jobId,
        snapshotRoot,
        () => {}
      );
      return NextResponse.json({ ok: true, summary });
    }

    return NextResponse.json(
      { error: `Hành động "${action}" không hợp lệ.` },
      { status: 400 }
    );
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
  try {
    const { id } = await params;
    const jobId = Number(id);
    const db = getDb();
    const row = db
      .prepare(
        `SELECT j.*, s.hostname, v.mount_path
         FROM backup_jobs j
         LEFT JOIN servers s ON s.id = j.server_id
         LEFT JOIN storage_volumes v ON v.id = j.volume_id
         WHERE j.id = ?`
      )
      .get(jobId);

    if (!row) {
      return NextResponse.json({ error: 'Không tìm thấy Job.' }, { status: 404 });
    }

    if (Number(row.is_pinned) === 1) {
      return NextResponse.json(
        {
          error:
            'Bản sao lưu này đang được KHÓA (Pinned). Vui lòng mở khóa trước khi xóa.',
        },
        { status: 400 }
      );
    }

    if (row.mount_path && row.hostname && row.snapshot_name && row.job_type === 'BACKUP') {
      const hostDir = path.join(String(row.mount_path), String(row.hostname));
      const snapDir = path.join(hostDir, String(row.snapshot_name));
      const latestReal = resolveLatestSnapshotDir(hostDir);
      if (latestReal && path.resolve(latestReal) === path.resolve(snapDir)) {
        return NextResponse.json(
          {
            error:
              'Không thể xóa trực tiếp bản đang làm mốc symlink `latest` (cần thiết cho chuỗi Incremental Hard-Link).',
          },
          { status: 400 }
        );
      }
      if (fs.existsSync(snapDir)) {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
    }

    db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(jobId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


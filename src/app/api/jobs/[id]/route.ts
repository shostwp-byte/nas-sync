import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { resolveSafeSnapshotRoot } from '@/lib/engine/explorer';
import {
  cancelRunningOrQueuedJob,
  dispatchExistingJob,
} from '@/lib/engine/queue';
import { isSafeSnapshotName } from '@/lib/engine/safe-names';
import { verifyJobDatabasesInSandbox } from '@/lib/engine/sandbox-verifier';
import {
  acquireSnapshotReadPin,
  isSnapshotReadPinned,
} from '@/lib/engine/snapshot-pins';
import { resolveLatestSnapshotDir } from '@/lib/engine/volume-manager';

const ACTIVE_JOB_STATUSES = new Set([
  'QUEUED',
  'RUNNING',
  'RESUMING',
  'VERIFYING',
]);

function isReferencedByActiveRestore(
  jobId: number,
  serverId: number,
  snapshotName: string
): boolean {
  const db = getDb();
  const activeRestores = db
    .prepare(
      `SELECT server_id, snapshot_name, restore_options
       FROM backup_jobs
       WHERE job_type = 'RESTORE'
         AND status IN ('QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED')`
    )
    .all();

  const itemStmt = db.prepare('SELECT job_id FROM backup_items WHERE id = ?');

  for (const r of activeRestores) {
    if (
      Number(r.server_id) === Number(serverId) &&
      snapshotName &&
      String(r.snapshot_name) === snapshotName
    ) {
      return true;
    }
    if (!r.restore_options) continue;
    try {
      const parsed = JSON.parse(String(r.restore_options)) as {
        sourceJobId?: number;
        backupItemId?: number;
      };
      if (Number(parsed.sourceJobId) === jobId) {
        return true;
      }
      if (parsed.backupItemId) {
        const it = itemStmt.get(Number(parsed.backupItemId));
        if (it && Number(it.job_id) === jobId) {
          return true;
        }
      }
    } catch {
      // Ignore invalid JSON
    }
  }
  return false;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // A8 Fix: Bổ sung kiểm tra phân quyền phòng thủ nhiều lớp ngay trong route handler
    const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
    if (!guard.ok) return guard.response;

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
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải thông tin chi tiết Job.');
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR']);
    if (!guard.ok) return guard.response;

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
      const currentStatus = String(job.status);
      if (ACTIVE_JOB_STATUSES.has(currentStatus)) {
        return NextResponse.json(
          {
            error:
              'Tiến trình đang chạy hoặc đang trong hàng đợi, không thể thử lại lúc này.',
          },
          { status: 409 }
        );
      }
      // N1 Fix: Chặn chạy lại Job đã COMPLETED (tránh ghi đè/xóa mất snapshot tốt) hoặc đang INTERRUPTED chờ tự động Resume
      if (currentStatus === 'COMPLETED') {
        return NextResponse.json(
          {
            error:
              'Tiến trình đã hoàn tất thành công — vui lòng tạo phiên sao lưu/khôi phục mới thay vì chạy đè lên bản cũ.',
          },
          { status: 409 }
        );
      }
      if (currentStatus === 'INTERRUPTED') {
        return NextResponse.json(
          {
            error:
              'Tiến trình đang trong chu kỳ tự động nối tiếp (Auto-Resume). Vui lòng đợi hoặc nhấn Hủy trước khi thử lại thủ công.',
          },
          { status: 409 }
        );
      }
      if (
        String(job.job_type) === 'BACKUP' &&
        (isReferencedByActiveRestore(
          jobId,
          Number(job.server_id),
          String(job.snapshot_name || '')
        ) ||
          isSnapshotReadPinned(
            Number(job.server_id),
            String(job.snapshot_name || '')
          ))
      ) {
        return NextResponse.json(
          {
            error:
              'Bản sao lưu này đang được tiến trình Khôi phục hoặc Tải về/Đồng bộ sử dụng, vui lòng đợi hoàn tất.',
          },
          { status: 409 }
        );
      }
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'QUEUED', retry_count = 0, current_phase = 'Đang xếp hàng thử lại...', error_log = NULL
         WHERE id = ? AND status IN ('FAILED', 'CANCELLED')`
      ).run(jobId);
      await dispatchExistingJob(
        jobId,
        String(job.job_type) === 'RESTORE' ? 'RESTORE' : 'BACKUP'
      );
      return NextResponse.json({ ok: true });
    }

    if (action === 'verify_sandbox') {
      if (ACTIVE_JOB_STATUSES.has(String(job.status))) {
        return NextResponse.json(
          {
            error:
              'Tiến trình đang chạy hoặc đang thẩm định, vui lòng đợi hoàn tất.',
          },
          { status: 409 }
        );
      }
      const { snapshotRoot } = resolveSafeSnapshotRoot(jobId);
      const releasePin = acquireSnapshotReadPin(
        Number(job.server_id),
        String(job.snapshot_name || '')
      );
      try {
        const summary = await verifyJobDatabasesInSandbox(
          jobId,
          snapshotRoot,
          () => {}
        );
        return NextResponse.json({ ok: true, summary });
      } finally {
        releasePin();
      }
    }

    return NextResponse.json(
      { error: `Hành động "${action}" không hợp lệ.` },
      { status: 400 }
    );
  } catch (err) {
    return safeErrorJson(err, 'Không thể thực hiện thao tác trên Job.');
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

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

    if (ACTIVE_JOB_STATUSES.has(String(row.status))) {
      return NextResponse.json(
        {
          error:
            'Không thể xóa tiến trình đang chạy hoặc đang trong hàng đợi. Vui lòng hủy tiến trình trước.',
        },
        { status: 409 }
      );
    }

    if (
      String(row.job_type) === 'BACKUP' &&
      (isReferencedByActiveRestore(
        jobId,
        Number(row.server_id),
        String(row.snapshot_name || '')
      ) ||
        isSnapshotReadPinned(
          Number(row.server_id),
          String(row.snapshot_name || '')
        ))
    ) {
      return NextResponse.json(
        {
          error:
            'Không thể xóa bản sao lưu đang được tiến trình Khôi phục, Tải về hoặc Đồng bộ Offsite sử dụng.',
        },
        { status: 409 }
      );
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
      const snapshotName = String(row.snapshot_name);
      const hostDir = path.resolve(String(row.mount_path), String(row.hostname));
      const snapDir = path.resolve(hostDir, snapshotName);
      const latestReal = resolveLatestSnapshotDir(hostDir);
      if (latestReal && path.resolve(latestReal) === snapDir) {
        return NextResponse.json(
          {
            error:
              'Không thể xóa trực tiếp bản đang làm mốc symlink `latest` (cần thiết cho chuỗi Incremental Hard-Link).',
          },
          { status: 400 }
        );
      }
      if (
        isSafeSnapshotName(snapshotName) &&
        path.dirname(snapDir) === hostDir &&
        fs.existsSync(snapDir)
      ) {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
    }

    db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(jobId);

    recordAuditLog({
      session: guard.session,
      action: 'JOB_DELETE',
      resourceType: 'JOB',
      resourceId: String(jobId),
      detail: `Xóa bản ghi tiến trình / Snapshot #${jobId} (${
        row.hostname || 'unknown'
      }@${row.snapshot_name || ''})`,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể xóa bản ghi tiến trình.');
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { isSafeSnapshotName } from './safe-names';
import { isSnapshotReadPinned } from './snapshot-pins';
import { refreshAllVolumes, resolveLatestSnapshotDir } from './volume-manager';
import { removeDirectoryTreeNonBlocking } from './worker-state';
import type { RetentionPolicy } from '@/types';

interface SnapshotCandidate {
  jobId: number;
  serverId: number;
  hostname: string;
  volumeId: number;
  mountPath: string;
  snapshotName: string;
  createdAt: Date;
  isPinned: boolean;
}

function getLocalDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalWeekKey(d: Date): string {
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getLocalMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function collectActiveRestoreProtection(serverId: number): {
  protectedJobIds: Set<number>;
  protectedSnapshotNames: Set<string>;
} {
  const db = getDb();
  const protectedJobIds = new Set<number>();
  const protectedSnapshotNames = new Set<string>();

  const activeRestores = db
    .prepare(
      `SELECT server_id, snapshot_name, restore_options
       FROM backup_jobs
       WHERE job_type = 'RESTORE'
         AND status IN ('QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED')`
    )
    .all();

  const itemStmt = db.prepare(
    'SELECT job_id, server_id, snapshot_name FROM backup_items WHERE id = ?'
  );

  for (const r of activeRestores) {
    if (Number(r.server_id) === serverId && r.snapshot_name) {
      protectedSnapshotNames.add(String(r.snapshot_name));
    }
    if (!r.restore_options) continue;
    try {
      const parsed = JSON.parse(String(r.restore_options)) as {
        sourceJobId?: number;
        backupItemId?: number;
      };
      if (parsed.sourceJobId && Number.isFinite(Number(parsed.sourceJobId))) {
        protectedJobIds.add(Number(parsed.sourceJobId));
      }
      if (parsed.backupItemId && Number.isFinite(Number(parsed.backupItemId))) {
        const itemRow = itemStmt.get(Number(parsed.backupItemId));
        if (itemRow) {
          protectedJobIds.add(Number(itemRow.job_id));
          if (Number(itemRow.server_id) === serverId && itemRow.snapshot_name) {
            protectedSnapshotNames.add(String(itemRow.snapshot_name));
          }
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  return { protectedJobIds, protectedSnapshotNames };
}

/**
 * Mục 9.4: Chính sách Lưu trữ GFS (Grandfather-Father-Son Retention)
 * Mặc định: Giữ lại 7 bản Daily + 4 bản Weekly (ưu tiên Chủ nhật) + 6 bản Monthly (ưu tiên mùng 1)
 * Tuyệt đối không xóa bản đang là symlink `latest`, bản `is_pinned`, hoặc bản đang phục vụ Restore.
 */
export async function applyGfsRetentionForServer(
  serverId: number,
  policy: RetentionPolicy,
  dryRun = false
): Promise<{
  keptSnapshots: Array<{ snapshotName: string; reason: string }>;
  deletedSnapshots: string[];
  freedVolumesRefreshed: boolean;
}> {
  const safeDaily = Math.max(1, Math.floor(Number(policy?.daily) || 7));
  const safeWeekly = Math.max(0, Math.floor(Number(policy?.weekly ?? 4) || 0));
  const safeMonthly = Math.max(0, Math.floor(Number(policy?.monthly ?? 6) || 0));

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         j.id AS job_id,
         j.server_id,
         s.hostname,
         j.volume_id,
         v.mount_path,
         j.snapshot_name,
         j.created_at,
         j.is_pinned,
         (SELECT COUNT(*) FROM backup_items bi WHERE bi.job_id = j.id AND bi.is_pinned = 1) AS pinned_items
       FROM backup_jobs j
       JOIN servers s ON s.id = j.server_id
       JOIN storage_volumes v ON v.id = j.volume_id
       WHERE j.server_id = ? AND j.job_type = 'BACKUP' AND j.status = 'COMPLETED'
       ORDER BY j.created_at DESC`
    )
    .all(serverId);

  const candidates: SnapshotCandidate[] = rows.map((r) => ({
    jobId: Number(r.job_id),
    serverId: Number(r.server_id),
    hostname: String(r.hostname),
    volumeId: Number(r.volume_id),
    mountPath: String(r.mount_path),
    snapshotName: String(r.snapshot_name),
    createdAt: new Date(String(r.created_at).replace(' ', 'T') + 'Z'),
    isPinned: Number(r.is_pinned) === 1 || Number(r.pinned_items) > 0,
  }));

  const { protectedJobIds, protectedSnapshotNames } =
    collectActiveRestoreProtection(serverId);

  const keepMap = new Map<number, string>();

  // 1. Luôn giữ lại bản mới nhất tuyệt đối, bản Pinned, bản đang trỏ bởi symlink latest, hoặc bản đang Restore
  candidates.forEach((c, idx) => {
    const latestDir = resolveLatestSnapshotDir(path.join(c.mountPath, c.hostname));
    const snapDir = path.join(c.mountPath, c.hostname, c.snapshotName);
    if (idx === 0) {
      keepMap.set(c.jobId, 'Latest (Bản mới nhất)');
    } else if (c.isPinned) {
      keepMap.set(c.jobId, 'Pinned (Đã khóa bảo vệ)');
    } else if (latestDir && path.resolve(latestDir) === path.resolve(snapDir)) {
      keepMap.set(c.jobId, 'Active Symlink Latest');
    } else if (
      protectedJobIds.has(c.jobId) ||
      protectedSnapshotNames.has(c.snapshotName)
    ) {
      keepMap.set(c.jobId, 'Active Restore (Đang phục vụ khôi phục)');
    } else if (isSnapshotReadPinned(c.serverId, c.snapshotName)) {
      keepMap.set(
        c.jobId,
        'Active Reader Pin (Đang tải về / Kiểm định / Đồng bộ Offsite)'
      );
    }
  });

  // 2. Daily buckets (Mới nhất mỗi ngày theo giờ địa phương - tối đa safeDaily ngày)
  const seenDays = new Set<string>();
  for (const c of candidates) {
    if (seenDays.size >= safeDaily) break;
    const dayKey = getLocalDayKey(c.createdAt);
    if (!seenDays.has(dayKey)) {
      seenDays.add(dayKey);
      if (!keepMap.has(c.jobId)) {
        keepMap.set(c.jobId, `GFS Daily (${dayKey})`);
      }
    }
  }

  // 3. Weekly buckets (Ưu tiên Chủ nhật của mỗi tuần theo giờ địa phương - tối đa safeWeekly tuần)
  const byWeek = new Map<string, SnapshotCandidate[]>();
  for (const c of candidates) {
    const wk = getLocalWeekKey(c.createdAt);
    const arr = byWeek.get(wk) || [];
    arr.push(c);
    byWeek.set(wk, arr);
  }
  let weeklyCount = 0;
  for (const [wk, list] of byWeek.entries()) {
    if (weeklyCount >= safeWeekly) break;
    const sundaySnap = list.find((item) => item.createdAt.getDay() === 0) || list[0];
    if (!keepMap.has(sundaySnap.jobId)) {
      keepMap.set(sundaySnap.jobId, `GFS Weekly (${wk})`);
    }
    weeklyCount++;
  }

  // 4. Monthly buckets (Ưu tiên ngày mùng 1 hàng tháng theo giờ địa phương - tối đa safeMonthly tháng)
  const byMonth = new Map<string, SnapshotCandidate[]>();
  for (const c of candidates) {
    const mk = getLocalMonthKey(c.createdAt);
    const arr = byMonth.get(mk) || [];
    arr.push(c);
    byMonth.set(mk, arr);
  }
  let monthlyCount = 0;
  for (const [mk, list] of byMonth.entries()) {
    if (monthlyCount >= safeMonthly) break;
    const firstDaySnap =
      list.find((item) => item.createdAt.getDate() === 1) ||
      list[list.length - 1];
    if (!keepMap.has(firstDaySnap.jobId)) {
      keepMap.set(firstDaySnap.jobId, `GFS Monthly (${mk})`);
    }
    monthlyCount++;
  }

  const keptSnapshots: Array<{ snapshotName: string; reason: string }> = [];
  const deletedSnapshots: string[] = [];

  for (const c of candidates) {
    const reason = keepMap.get(c.jobId);
    if (reason) {
      keptSnapshots.push({ snapshotName: c.snapshotName, reason });
      continue;
    }

    if (!dryRun) {
      // Kiểm tra lại Read Pin ngay trước bước rename đồng bộ để không bao giờ xóa nhầm bản vừa mở tải trong lúc chờ xóa bản trước
      if (isSnapshotReadPinned(c.serverId, c.snapshotName)) {
        keptSnapshots.push({
          snapshotName: c.snapshotName,
          reason: 'Active Reader Pin (Đang tải về / Kiểm định / Đồng bộ Offsite)',
        });
        continue;
      }
      deletedSnapshots.push(c.snapshotName);
      const hostDir = path.resolve(c.mountPath, c.hostname);
      const snapDir = path.resolve(hostDir, c.snapshotName);
      if (
        isSafeSnapshotName(c.snapshotName) &&
        path.dirname(snapDir) === hostDir &&
        fs.existsSync(snapDir)
      ) {
        await removeDirectoryTreeNonBlocking(snapDir);
      }
      db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(c.jobId);
    } else {
      deletedSnapshots.push(c.snapshotName);
    }
  }

  if (!dryRun && deletedSnapshots.length > 0) {
    await refreshAllVolumes();
  }

  return {
    keptSnapshots,
    deletedSnapshots,
    freedVolumesRefreshed: !dryRun && deletedSnapshots.length > 0,
  };
}


import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { refreshAllVolumes, resolveLatestSnapshotDir } from './volume-manager';
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

function getIsoDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getIsoWeekKey(d: Date): string {
  const copy = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(copy.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((copy.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${copy.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Mục 9.4: Chính sách Lưu trữ GFS (Grandfather-Father-Son Retention)
 * Mặc định: Giữ lại 7 bản Daily + 4 bản Weekly (ưu tiên Chủ nhật) + 6 bản Monthly (ưu tiên mùng 1)
 * Tuyệt đối không xóa bản đang là symlink `latest` hoặc bản đã được gắn cờ `is_pinned`.
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

  const keepMap = new Map<number, string>();

  // 1. Luôn giữ lại bản mới nhất tuyệt đối và mọi bản được Pin hoặc đang trỏ bởi symlink latest
  candidates.forEach((c, idx) => {
    const latestDir = resolveLatestSnapshotDir(path.join(c.mountPath, c.hostname));
    const snapDir = path.join(c.mountPath, c.hostname, c.snapshotName);
    if (idx === 0) {
      keepMap.set(c.jobId, 'Latest (Bản mới nhất)');
    } else if (c.isPinned) {
      keepMap.set(c.jobId, 'Pinned (Đã khóa bảo vệ)');
    } else if (latestDir && path.resolve(latestDir) === path.resolve(snapDir)) {
      keepMap.set(c.jobId, 'Active Symlink Latest');
    }
  });

  // 2. Daily buckets (Mới nhất mỗi ngày - tối đa policy.daily ngày)
  const seenDays = new Set<string>();
  for (const c of candidates) {
    if (seenDays.size >= policy.daily) break;
    const dayKey = getIsoDayKey(c.createdAt);
    if (!seenDays.has(dayKey)) {
      seenDays.add(dayKey);
      if (!keepMap.has(c.jobId)) {
        keepMap.set(c.jobId, `GFS Daily (${dayKey})`);
      }
    }
  }

  // 3. Weekly buckets (Ưu tiên Chủ nhật của mỗi tuần - tối đa policy.weekly tuần)
  const byWeek = new Map<string, SnapshotCandidate[]>();
  for (const c of candidates) {
    const wk = getIsoWeekKey(c.createdAt);
    const arr = byWeek.get(wk) || [];
    arr.push(c);
    byWeek.set(wk, arr);
  }
  let weeklyCount = 0;
  for (const [wk, list] of byWeek.entries()) {
    if (weeklyCount >= policy.weekly) break;
    const sundaySnap = list.find((item) => item.createdAt.getDay() === 0) || list[0];
    if (!keepMap.has(sundaySnap.jobId)) {
      keepMap.set(sundaySnap.jobId, `GFS Weekly (${wk})`);
    }
    weeklyCount++;
  }

  // 4. Monthly buckets (Ưu tiên ngày mùng 1 hàng tháng - tối đa policy.monthly tháng)
  const byMonth = new Map<string, SnapshotCandidate[]>();
  for (const c of candidates) {
    const mk = getMonthKey(c.createdAt);
    const arr = byMonth.get(mk) || [];
    arr.push(c);
    byMonth.set(mk, arr);
  }
  let monthlyCount = 0;
  for (const [mk, list] of byMonth.entries()) {
    if (monthlyCount >= policy.monthly) break;
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

    deletedSnapshots.push(c.snapshotName);
    if (!dryRun) {
      const snapDir = path.join(c.mountPath, c.hostname, c.snapshotName);
      if (fs.existsSync(snapDir)) {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
      db.prepare('DELETE FROM backup_jobs WHERE id = ?').run(c.jobId);
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


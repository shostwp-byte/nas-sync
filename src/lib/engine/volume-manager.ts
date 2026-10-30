import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { emitVolumeUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import { execLocalCommand } from '@/lib/ssh';
import type { ServerRecord, StorageVolume } from '@/types';

/**
 * Tạo/cập nhật con trỏ latest an toàn trên cả Linux (ln -snf) và Windows (Directory Junction).
 */
export async function updateLatestSymlink(
  hostDir: string,
  targetSnapshotDir: string
): Promise<void> {
  const latestPath = path.join(hostDir, 'latest');

  if (process.platform !== 'win32') {
    await execLocalCommand('ln', ['-snf', targetSnapshotDir, latestPath], 10000);
    return;
  }

  try {
    if (
      fs.existsSync(latestPath) ||
      fs.lstatSync(latestPath, { throwIfNoEntry: false })
    ) {
      const stat = fs.lstatSync(latestPath);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(latestPath);
      } else if (stat.isDirectory()) {
        fs.rmdirSync(latestPath);
      }
    }
  } catch {
    // Ignore if doesn't exist
  }

  fs.symlinkSync(targetSnapshotDir, latestPath, 'junction');
}

export function resolveLatestSnapshotDir(hostDir: string): string | null {
  const latestPath = path.join(hostDir, 'latest');
  try {
    if (!fs.existsSync(latestPath)) return null;
    return fs.realpathSync(latestPath);
  } catch {
    return null;
  }
}

function parsePosixDfOutput(
  stdout: string,
  multiplier: number
): { totalBytes: number; usedBytes: number; freeBytes: number } | null {
  const lines = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  // Dòng cuối chuẩn POSIX (-P): <Filesystem> <Blocks> <Used> <Available> <Use%> <Mounted on>
  const parts = lines[lines.length - 1].split(/\s+/);
  if (parts.length < 6) return null;

  const blocks = Number(parts[parts.length - 5]);
  const used = Number(parts[parts.length - 4]);
  const avail = Number(parts[parts.length - 3]);

  if (
    Number.isFinite(blocks) &&
    blocks > 0 &&
    Number.isFinite(used) &&
    Number.isFinite(avail)
  ) {
    return {
      totalBytes: Math.round(blocks * multiplier),
      usedBytes: Math.round(used * multiplier),
      freeBytes: Math.round(avail * multiplier),
    };
  }
  return null;
}

/**
 * Quét dung lượng thực tế của một Volume trên Synology NAS / Linux / Windows.
 * Hỗ trợ đa tầng fallback (BusyBox df -k -P tránh lỗi statx seccomp trên kernel Synology cũ -> GNU df -B1 -P -> fs.statfsSync).
 */
export async function inspectVolumeDiskSpace(mountPath: string): Promise<{
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}> {
  try {
    fs.mkdirSync(mountPath, { recursive: true });
  } catch {
    // Bỏ qua nếu đã là mount point hoặc bị chặn statx tạm thời
  }

  if (process.platform !== 'win32') {
    // Ưu tiên 1: BusyBox df -k -P (dùng syscall statfs cổ điển, tương thích 100% với mọi Kernel Synology DSM kể cả khi seccomp chặn statx)
    try {
      const bbRes = await execLocalCommand(
        '/bin/busybox',
        ['df', '-k', '-P', mountPath],
        8000
      );
      if (bbRes.code === 0) {
        const parsed = parsePosixDfOutput(bbRes.stdout, 1024);
        if (parsed) return parsed;
      }
    } catch {
      // Bỏ qua nếu không phải môi trường Alpine BusyBox
    }

    // Ưu tiên 2: df -k -P chuẩn POSIX
    try {
      const dfKRes = await execLocalCommand('df', ['-k', '-P', mountPath], 8000);
      if (dfKRes.code === 0) {
        const parsed = parsePosixDfOutput(dfKRes.stdout, 1024);
        if (parsed) return parsed;
      }
    } catch {
      // Fallback tiếp
    }

    // Ưu tiên 3: GNU df -B1 -P
    try {
      const dfBRes = await execLocalCommand('df', ['-B1', '-P', mountPath], 8000);
      if (dfBRes.code === 0) {
        const parsed = parsePosixDfOutput(dfBRes.stdout, 1);
        if (parsed) return parsed;
      }
    } catch {
      // Fallback sang fs.statfsSync
    }
  }

  const stat = fs.statfsSync(mountPath);
  const totalBytes = Math.round(Number(stat.blocks) * Number(stat.bsize));
  const freeBytes = Math.round(Number(stat.bavail) * Number(stat.bsize));
  const usedBytes = Math.max(
    0,
    Math.round(totalBytes - Number(stat.bfree) * Number(stat.bsize))
  );

  return { totalBytes, usedBytes, freeBytes };
}

export async function refreshAllVolumes(): Promise<StorageVolume[]> {
  const db = getDb();
  const volumes = db
    .prepare('SELECT * FROM storage_volumes ORDER BY priority ASC, id ASC')
    .all() as unknown as StorageVolume[];

  const updateStmt = db.prepare(
    `UPDATE storage_volumes
     SET total_bytes = ?, used_bytes = ?, free_bytes = ?, status = ?, last_checked_at = datetime('now')
     WHERE id = ?`
  );

  for (const vol of volumes) {
    try {
      const { totalBytes, usedBytes, freeBytes } = await inspectVolumeDiskSpace(
        vol.mount_path
      );
      let nextStatus = vol.status;
      if (vol.status !== 'MAINTENANCE' && totalBytes > 0) {
        const usagePercent = (usedBytes / totalBytes) * 100;
        const freeGb = freeBytes / 1024 ** 3;
        if (usagePercent >= vol.max_usage_percent || freeGb < vol.min_free_gb) {
          nextStatus = 'FULL';
        } else if (
          vol.status === 'FULL' &&
          usagePercent < vol.max_usage_percent - 3 &&
          freeGb >= vol.min_free_gb
        ) {
          nextStatus = 'ACTIVE';
        }
      }
      updateStmt.run(totalBytes, usedBytes, freeBytes, nextStatus, vol.id);
    } catch (err) {
      console.warn(
        `[Volume Manager] Không thể đọc dung lượng ${vol.mount_path}:`,
        (err as Error).message
      );
    }
  }

  emitVolumeUpdated();
  return db
    .prepare('SELECT * FROM storage_volumes ORDER BY priority ASC, id ASC')
    .all() as unknown as StorageVolume[];
}

/**
 * Mục 7: Pre-Flight Check & Smart Multi-Volume Overflow + Local Seeding giữ Hard Link
 */
export async function ensureActiveVolumeForBackup(
  server: ServerRecord,
  onLog: (msg: string) => void
): Promise<StorageVolume> {
  const volumes = await refreshAllVolumes();
  const db = getDb();

  let currentVol = volumes.find((v) => v.id === server.assigned_volume_id);

  if (!currentVol) {
    const firstActive = volumes.find((v) => v.status === 'ACTIVE');
    if (!firstActive) {
      throw new Error(
        'Tất cả phân vùng lưu trữ (Storage Volumes) trên NAS đều đã ĐẦY hoặc đang BẢO TRÌ!'
      );
    }
    db.prepare('UPDATE servers SET assigned_volume_id = ? WHERE id = ?').run(
      firstActive.id,
      server.id
    );
    onLog(
      `[Volume] Gán máy chủ ${server.hostname} vào phân vùng mặc định: ${firstActive.name} (${firstActive.mount_path})`
    );
    return firstActive;
  }

  const usagePercent =
    currentVol.total_bytes > 0
      ? (currentVol.used_bytes / currentVol.total_bytes) * 100
      : 0;
  const freeGb = currentVol.free_bytes / 1024 ** 3;

  const isOverflow =
    currentVol.status === 'FULL' ||
    currentVol.status === 'MAINTENANCE' ||
    (currentVol.total_bytes > 0 &&
      (usagePercent >= currentVol.max_usage_percent ||
        freeGb < currentVol.min_free_gb));

  if (!isOverflow) {
    onLog(
      `[Pre-Flight] Phân vùng ${currentVol.name} (${currentVol.mount_path}) hợp lệ — Đã dùng ${usagePercent.toFixed(
        1
      )}%, Trống ${freeGb.toFixed(1)} GB.`
    );
    return currentVol;
  }

  if (currentVol.status !== 'MAINTENANCE') {
    db.prepare(`UPDATE storage_volumes SET status = 'FULL' WHERE id = ?`).run(
      currentVol.id
    );
    emitVolumeUpdated();
  }

  const targetVol = volumes.find(
    (v) => v.id !== currentVol!.id && v.status === 'ACTIVE'
  );

  if (!targetVol) {
    await createSystemAlert({
      severity: 'CRITICAL',
      category: 'VOLUME',
      title: `Hết dung lượng lưu trữ trên toàn bộ phân vùng NAS!`,
      message: `Phân vùng ${currentVol.name} (${currentVol.mount_path}) đã vượt ngưỡng an toàn (${usagePercent.toFixed(
        1
      )}%, còn trống ${freeGb.toFixed(
        1
      )} GB) và không còn phân vùng ACTIVE dự phòng nào cho ${server.hostname}.`,
      serverId: server.id,
    });
    throw new Error(
      `Phân vùng ${currentVol.name} đã đầy (${usagePercent.toFixed(
        1
      )}%) và không tìm thấy Volume ACTIVE kế tiếp!`
    );
  }

  onLog(
    `[Multi-Volume Overflow] Cảnh báo: ${currentVol.name} đạt ngưỡng (${usagePercent.toFixed(
      1
    )}%). Đang chuyển hướng lưu trữ sang ${targetVol.name} (${targetVol.mount_path})...`
  );

  await createSystemAlert({
    severity: 'WARNING',
    category: 'VOLUME',
    title: `Tự động chuyển đổi Volume: ${currentVol.name} ➔ ${targetVol.name}`,
    message: `Phân vùng ${currentVol.name} đã chạm ngưỡng (${usagePercent.toFixed(
      1
    )}% / trống ${freeGb.toFixed(1)} GB). Hệ thống tự động thực hiện Local Seeding bản latest của ${
      server.hostname
    } sang ${targetVol.name} (${targetVol.mount_path}) để bảo toàn chuỗi Incremental Hard-Link.`,
    serverId: server.id,
  });

  await performCrossVolumeLocalSeeding(server, currentVol, targetVol, onLog);

  db.prepare('UPDATE servers SET assigned_volume_id = ? WHERE id = ?').run(
    targetVol.id,
    server.id
  );

  return targetVol;
}

export async function performCrossVolumeLocalSeeding(
  server: ServerRecord,
  fromVolume: StorageVolume,
  toVolume: StorageVolume,
  onLog: (msg: string) => void
): Promise<void> {
  const oldHostDir = path.join(fromVolume.mount_path, server.hostname);
  const oldLatestReal = resolveLatestSnapshotDir(oldHostDir);

  if (!oldLatestReal || !fs.existsSync(oldLatestReal)) {
    onLog(
      `[Local Seeding] Máy chủ ${server.hostname} chưa có bản latest trên ${fromVolume.name}, bỏ qua bước copy seed_base.`
    );
    return;
  }

  const newHostDir = path.join(toVolume.mount_path, server.hostname);
  const seedDir = path.join(newHostDir, 'seed_base');
  fs.mkdirSync(seedDir, { recursive: true });

  onLog(
    `[Local Seeding] Đang copy nội bộ NAS: ${oldLatestReal} ➔ ${seedDir} (Bảo toàn chuỗi --link-dest)...`
  );

  if (process.platform !== 'win32') {
    const res = await execLocalCommand(
      'rsync',
      ['-a', '--delete', `${oldLatestReal}/`, `${seedDir}/`],
      3600 * 1000
    );
    if (res.code !== 0) {
      throw new Error(`Local Seeding rsync thất bại: ${res.stderr}`);
    }
  } else {
    fs.cpSync(oldLatestReal, seedDir, { recursive: true, force: true });
  }

  await updateLatestSymlink(newHostDir, seedDir);
  onLog(
    `[Local Seeding] Hoàn tất tạo mốc seed_base và cập nhật symlink latest trên ${toVolume.name}.`
  );
}

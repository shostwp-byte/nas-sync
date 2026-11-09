import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress } from '@/lib/events';
import type { BackupJob, InProgressState } from '@/types';
import { isSafeServerLabel, isSafeSnapshotName } from './safe-names';

export const STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_BACKUP_RETRIES = 10;
export const DETACHED_PROCESS_GROUP = process.platform !== 'win32';

export class RetryableNetworkError extends Error {
  readonly rsyncExitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'RetryableNetworkError';
    this.rsyncExitCode = exitCode;
  }
}

declare global {
  var __nasSyncCancelledJobIds: Set<number> | undefined;
  var __nasSyncJobChildProcesses: Map<number, Set<ChildProcess>> | undefined;
}

function getCancelledJobIdsSet(): Set<number> {
  if (!globalThis.__nasSyncCancelledJobIds) {
    globalThis.__nasSyncCancelledJobIds = new Set<number>();
  }
  return globalThis.__nasSyncCancelledJobIds;
}

function getJobChildProcessesMap(): Map<number, Set<ChildProcess>> {
  if (!globalThis.__nasSyncJobChildProcesses) {
    globalThis.__nasSyncJobChildProcesses = new Map<number, Set<ChildProcess>>();
  }
  return globalThis.__nasSyncJobChildProcesses;
}

/**
 * N2 Fix: Gửi tín hiệu dừng tới toàn bộ Process Group (-pid) trên POSIX khi child được spawn với `detached: true`,
 * đảm bảo không còn tiến trình con mồ côi (`ssh`, `zstd`, `mariadb`, `psql`, `rsync`) giữ mở pipe.
 */
export function terminateChildGracefully(child: ChildProcess): void {
  const pid = child.pid;
  const signalProcessTree = (sig: NodeJS.Signals): boolean => {
    if (pid && pid > 0 && process.platform !== 'win32') {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        // Fallback nếu tiến trình không phải group leader hoặc đã thoát
      }
    }
    try {
      return child.kill(sig);
    } catch {
      return false;
    }
  };

  if (!signalProcessTree('SIGTERM')) {
    return;
  }

  const forceTimer = setTimeout(() => {
    if (child.exitCode === null) {
      signalProcessTree('SIGKILL');
    }
  }, 5000);
  forceTimer.unref();
}

export function registerJobChildProcess(
  jobId: number,
  child: ChildProcess
): () => void {
  const map = getJobChildProcessesMap();
  let set = map.get(jobId);
  if (!set) {
    set = new Set<ChildProcess>();
    map.set(jobId, set);
  }
  set.add(child);

  const unregister = () => {
    const curr = map.get(jobId);
    if (!curr) return;
    curr.delete(child);
    if (curr.size === 0) {
      map.delete(jobId);
    }
  };

  child.once('close', unregister);
  child.once('error', unregister);
  return unregister;
}

export function killJobChildProcesses(jobId: number): number {
  const map = getJobChildProcessesMap();
  const set = map.get(jobId);
  if (!set || set.size === 0) return 0;

  let killedCount = 0;
  for (const child of Array.from(set)) {
    terminateChildGracefully(child);
    killedCount++;
  }
  map.delete(jobId);
  return killedCount;
}

export function requestCancelJob(jobId: number): void {
  getCancelledJobIdsSet().add(jobId);
  killJobChildProcesses(jobId);
}

export function clearCancelledJob(jobId: number): void {
  getCancelledJobIdsSet().delete(jobId);
  getJobChildProcessesMap().delete(jobId);
}

export function isJobCancelled(jobId: number): boolean {
  return getCancelledJobIdsSet().has(jobId);
}

export function throwIfCancelled(
  jobId: number,
  message = 'Job đã bị hủy bởi quản trị viên.'
): void {
  if (isJobCancelled(jobId)) {
    throw new Error(message);
  }
}

/**
 * N23 Fix: Đổi tên nguyên tử thư mục sang `.deleting_<name>_<ts>_<rand>` ngay lập tức (không có `await` xen giữa
 * bước kiểm tra Snapshot Read Pin) rồi xóa bất đồng bộ qua `fs.promises.rm` để không bao giờ chặn Event Loop
 * hàng chục giây trên mảng đĩa HDD nhiều triệu hard-link (ngăn lỗi BullMQ Missing Lock).
 */
export async function removeDirectoryTreeNonBlocking(
  targetPath: string
): Promise<void> {
  const lst = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  if (!lst) return;
  if (lst.isSymbolicLink()) {
    try {
      fs.unlinkSync(targetPath);
    } catch {
      // Ignore already unlinked
    }
    return;
  }
  if (!lst.isDirectory()) {
    await fs.promises.rm(targetPath, { force: true });
    return;
  }

  const parentDir = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const trashPath = path.join(
    parentDir,
    `.deleting_${baseName}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );

  let movedToTrash: boolean;
  try {
    fs.renameSync(targetPath, trashPath);
    movedToTrash = true;
  } catch {
    movedToTrash = false;
  }

  await fs.promises.rm(movedToTrash ? trashPath : targetPath, {
    recursive: true,
    force: true,
  });
}

/**
 * N6 & N23 Fix: Xóa thư mục tạm `.in_progress_<snapshot>` khi Job chuyển sang trạng thái kết thúc lỗi/hủy
 * (FAILED / CANCELLED) bằng cách đổi tên nguyên tử sang `.deleting_*` rồi dọn nền bất đồng bộ,
 * không rò rỉ dung lượng ổ đĩa NAS và không chặn Event Loop.
 */
export function cleanupInProgressSnapshotDirsForJob(jobId: number): void {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT j.server_id, j.snapshot_name, j.job_type, s.hostname
         FROM backup_jobs j
         LEFT JOIN servers s ON s.id = j.server_id
         WHERE j.id = ?`
      )
      .get(jobId);

    if (!row || String(row.job_type) !== 'BACKUP') return;

    const serverId = Number(row.server_id);
    const hostname = String(row.hostname || '').trim();
    const snapshotName = String(row.snapshot_name || '').trim();
    if (
      !hostname ||
      !snapshotName ||
      !isSafeServerLabel(hostname) ||
      !isSafeSnapshotName(snapshotName)
    ) {
      return;
    }

    // Không xóa nếu vẫn còn một Job khác của cùng server đang giữ cùng tên snapshot ở trạng thái hoạt động/chờ resume
    const otherActive = db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM backup_jobs
         WHERE server_id = ?
           AND snapshot_name = ?
           AND id != ?
           AND status IN ('QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED')`
      )
      .get(serverId, snapshotName, jobId);
    if (Number(otherActive?.cnt || 0) > 0) {
      return;
    }

    const volumes = db
      .prepare('SELECT mount_path FROM storage_volumes')
      .all();
    for (const vol of volumes) {
      const mountPath = String(vol.mount_path || '').trim();
      if (!mountPath) continue;
      const hostDir = path.resolve(mountPath, hostname);
      const targetDir = path.resolve(hostDir, `.in_progress_${snapshotName}`);
      if (path.dirname(targetDir) !== hostDir || !fs.existsSync(targetDir)) {
        continue;
      }
      const lst = fs.lstatSync(targetDir, { throwIfNoEntry: false });
      if (lst && !lst.isSymbolicLink() && lst.isDirectory()) {
        void removeDirectoryTreeNonBlocking(targetDir).catch((rmErr) => {
          console.warn(
            `[NAS-Sync Cleanup] Lỗi xóa nền thư mục .in_progress cho Job #${jobId}:`,
            (rmErr as Error).message
          );
        });
      }
    }
  } catch (err) {
    console.warn(
      `[NAS-Sync Cleanup] Không thể dọn thư mục .in_progress cho Job #${jobId}:`,
      (err as Error).message
    );
  }
}

/**
 * N6 & N23 Fix: Quét dọn các thư mục `.in_progress_*` mồ côi và `.deleting_*` dở dang lúc khởi động.
 */
export function sweepOrphanedInProgressDirsOnStartup(): number {
  let removed = 0;
  try {
    const db = getDb();
    const volumes = db.prepare('SELECT mount_path FROM storage_volumes').all();
    const servers = db.prepare('SELECT id, hostname FROM servers').all();
    const activeStmt = db.prepare(
      `SELECT COUNT(*) AS cnt
       FROM backup_jobs
       WHERE server_id = ?
         AND snapshot_name = ?
         AND status IN ('QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED')`
    );

    for (const vol of volumes) {
      const mountPath = String(vol.mount_path || '').trim();
      if (!mountPath || !fs.existsSync(mountPath)) continue;

      for (const srv of servers) {
        const serverId = Number(srv.id);
        const hostname = String(srv.hostname || '').trim();
        if (!hostname || !isSafeServerLabel(hostname)) continue;

        const hostDir = path.resolve(mountPath, hostname);
        if (!fs.existsSync(hostDir)) continue;

        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(hostDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (entry.name.startsWith('.deleting_')) {
            const fullTrash = path.resolve(hostDir, entry.name);
            if (path.dirname(fullTrash) !== hostDir) continue;
            const lst = fs.lstatSync(fullTrash, { throwIfNoEntry: false });
            if (lst && !lst.isSymbolicLink() && lst.isDirectory()) {
              void fs.promises
                .rm(fullTrash, { recursive: true, force: true })
                .catch(() => {});
              removed++;
            }
            continue;
          }

          if (!entry.name.startsWith('.in_progress_')) continue;
          const snapName = entry.name.slice('.in_progress_'.length);
          if (!snapName || !isSafeSnapshotName(snapName)) continue;

          const activeCnt = Number(activeStmt.get(serverId, snapName)?.cnt || 0);
          if (activeCnt > 0) continue;

          const fullDir = path.resolve(hostDir, entry.name);
          if (path.dirname(fullDir) !== hostDir) continue;
          const lst = fs.lstatSync(fullDir, { throwIfNoEntry: false });
          if (lst && !lst.isSymbolicLink() && lst.isDirectory()) {
            void removeDirectoryTreeNonBlocking(fullDir).catch(() => {});
            removed++;
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      '[NAS-Sync Cleanup] Lỗi khi quét thư mục .in_progress mồ côi lúc khởi động:',
      (err as Error).message
    );
  }
  return removed;
}

export function loadOrCreateState(
  stateFilePath: string,
  jobId: number,
  snapshotName: string
): InProgressState {
  if (fs.existsSync(stateFilePath)) {
    try {
      return JSON.parse(
        fs.readFileSync(stateFilePath, 'utf8')
      ) as InProgressState;
    } catch {
      // Tạo mới nếu file state hỏng
    }
  }
  return {
    jobId,
    snapshotName,
    startedAt: new Date().toISOString(),
    completedDomains: {},
  };
}

export function saveState(stateFilePath: string, state: InProgressState): void {
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

export interface JobProgressPatch {
  status?: BackupJob['status'];
  progressPercent?: number;
  currentPhase?: string;
  currentDomain?: string;
  speedBps?: number;
  etaSeconds?: number;
  totalSizeBytes?: number;
  deltaSizeBytes?: number;
  retryCount?: number;
}

export function createJobLogger(params: {
  jobId: number;
  serverId: number;
  hostname: string;
  initialLog?: string | null;
  maxLines?: number;
}): (msg: string) => void {
  const { jobId, serverId, hostname, initialLog, maxLines = 250 } = params;
  const db = getDb();
  const logLines: string[] = initialLog
    ? initialLog.split('\n').filter(Boolean)
    : [];

  return (msg: string) => {
    const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const formatted = `[${ts}] ${msg}`;
    logLines.push(formatted);
    if (logLines.length > maxLines) {
      logLines.splice(0, logLines.length - maxLines);
    }
    db.prepare('UPDATE backup_jobs SET live_log = ? WHERE id = ?').run(
      logLines.join('\n'),
      jobId
    );
    emitJobLog({
      jobId,
      serverId,
      hostname,
      line: formatted,
      timestamp: ts,
    });
  };
}

export function createJobProgressUpdater(params: {
  jobId: number;
  serverId: number;
  hostname: string;
}): (patch: JobProgressPatch) => void {
  const { jobId, serverId, hostname } = params;
  const db = getDb();

  return (patch: JobProgressPatch) => {
    const curr = db
      .prepare('SELECT * FROM backup_jobs WHERE id = ?')
      .get(jobId) as unknown as BackupJob | undefined;
    if (!curr) return;

    const nextStatus = patch.status ?? curr.status;
    const nextPct = patch.progressPercent ?? curr.progress_percent;
    const nextPhase = patch.currentPhase ?? curr.current_phase;
    const nextDom = patch.currentDomain ?? curr.current_domain;
    const nextSpeed = patch.speedBps ?? curr.speed_bps;
    const nextEta = patch.etaSeconds ?? curr.eta_seconds;
    const nextTotal = patch.totalSizeBytes ?? curr.total_size_bytes;
    const nextDelta = patch.deltaSizeBytes ?? curr.delta_size_bytes;

    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, progress_percent = ?, current_phase = ?, current_domain = ?,
           speed_bps = ?, eta_seconds = ?, total_size_bytes = ?, delta_size_bytes = ?
       WHERE id = ?`
    ).run(
      nextStatus,
      nextPct,
      nextPhase,
      nextDom,
      nextSpeed,
      nextEta,
      nextTotal,
      nextDelta,
      jobId
    );

    emitJobProgress({
      jobId,
      serverId,
      hostname,
      status: nextStatus,
      progressPercent: nextPct,
      currentPhase: nextPhase,
      currentDomain: nextDom,
      speedBps: nextSpeed,
      etaSeconds: nextEta,
      deltaSizeBytes: nextDelta,
      totalSizeBytes: nextTotal,
      retryCount: patch.retryCount ?? curr.retry_count,
    });
  };
}

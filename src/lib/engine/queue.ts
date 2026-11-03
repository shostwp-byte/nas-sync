import fs from 'node:fs';
import path from 'node:path';
import { DelayedError, Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import cron, { type ScheduledTask } from 'node-cron';
import { getDb, getSetting } from '@/lib/db';
import { emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import type {
  BackupSchedule,
  RestoreRequestPayload,
  RetentionPolicy,
} from '@/types';
import {
  clearCancelledJob,
  executeBackupJob,
  requestCancelJob,
  RetryableNetworkError,
} from './backup-worker';
import { triggerImmutableWormSnapshot } from './worm-snapshot';
import {
  captureDailyStorageSnapshot,
  sendDailyMorningDigest,
} from './morning-digest';
import { executeRestoreJob } from './restore-worker';
import { applyGfsRetentionForServer } from './retention-gfs';
import {
  MAX_BACKUP_RETRIES,
  cleanupInProgressSnapshotDirsForJob,
  sweepOrphanedInProgressDirsOnStartup,
} from './worker-state';

export interface QueuedTaskPayload {
  jobId: number;
  jobType: 'BACKUP' | 'RESTORE';
  verifyDb?: boolean;
  retentionPolicy?: RetentionPolicy | null;
  scheduleBatchId?: string | null;
}

interface EngineState {
  initialized: boolean;
  mode: 'BULLMQ_REDIS' | 'LOCAL_MEMORY';
  redisUrl: string | null;
  bullQueue?: Queue<QueuedTaskPayload>;
  bullWorker?: Worker<QueuedTaskPayload>;
  cronTasks: Map<string, ScheduledTask>;
  localPending: QueuedTaskPayload[];
  localRunningCount: number;
  localMaxConcurrency: number;
}

declare global {
  var __nasSyncQueueEngine: EngineState | undefined;
  var __nasSyncServerLocks: Map<number, Promise<void>> | undefined;
  var __nasSyncServerLockDepths: Map<number, number> | undefined;
  var __nasSyncActiveExecutingJobs: Set<number> | undefined;
  var __nasSyncLastSnapshotSeq:
    | Map<number, { base: string; seq: number }>
    | undefined;
  var __nasSyncScheduleBtrfsBatches: Map<string, Set<number>> | undefined;
  var __nasSyncUpdating: boolean | undefined;
}

function getEngineState(): EngineState {
  if (!globalThis.__nasSyncQueueEngine) {
    globalThis.__nasSyncQueueEngine = {
      initialized: false,
      mode: 'LOCAL_MEMORY',
      redisUrl: null,
      cronTasks: new Map(),
      localPending: [],
      localRunningCount: 0,
      localMaxConcurrency: 3,
    };
  }
  return globalThis.__nasSyncQueueEngine;
}

function getServerLocksMap(): Map<number, Promise<void>> {
  if (!globalThis.__nasSyncServerLocks) {
    globalThis.__nasSyncServerLocks = new Map();
  }
  return globalThis.__nasSyncServerLocks;
}

function getServerLockDepthsMap(): Map<number, number> {
  if (!globalThis.__nasSyncServerLockDepths) {
    globalThis.__nasSyncServerLockDepths = new Map();
  }
  return globalThis.__nasSyncServerLockDepths;
}

function getActiveExecutingJobsSet(): Set<number> {
  if (!globalThis.__nasSyncActiveExecutingJobs) {
    globalThis.__nasSyncActiveExecutingJobs = new Set();
  }
  return globalThis.__nasSyncActiveExecutingJobs;
}

function getLastSnapshotSeqMap(): Map<number, { base: string; seq: number }> {
  if (!globalThis.__nasSyncLastSnapshotSeq) {
    globalThis.__nasSyncLastSnapshotSeq = new Map();
  }
  return globalThis.__nasSyncLastSnapshotSeq;
}

function getScheduleBtrfsBatchesMap(): Map<string, Set<number>> {
  if (!globalThis.__nasSyncScheduleBtrfsBatches) {
    globalThis.__nasSyncScheduleBtrfsBatches = new Map();
  }
  return globalThis.__nasSyncScheduleBtrfsBatches;
}

export function isServerLockBusy(serverId: number): boolean {
  return (getServerLockDepthsMap().get(serverId) || 0) > 0;
}

/**
 * Khóa tuần tự FIFO theo từng server_id để ngăn 2 tiến trình (Backup/Restore/Retention)
 * đụng độ đồng thời trên cùng 1 máy chủ VPS hoặc thư mục Snapshot.
 */
export async function acquireServerLock(serverId: number): Promise<() => void> {
  const locks = getServerLocksMap();
  const depths = getServerLockDepthsMap();
  depths.set(serverId, (depths.get(serverId) || 0) + 1);

  const prev = locks.get(serverId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = prev.then(() => current);
  locks.set(serverId, tail);

  await prev;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const nextDepth = (depths.get(serverId) || 1) - 1;
    if (nextDepth <= 0) {
      depths.delete(serverId);
    } else {
      depths.set(serverId, nextDepth);
    }
    releaseCurrent();
    if (locks.get(serverId) === tail) {
      locks.delete(serverId);
    }
  };
}

export async function acquireMultiServerLocks(
  serverIds: number[]
): Promise<() => void> {
  const sortedUnique = Array.from(
    new Set(serverIds.filter((id) => Number.isInteger(id) && id > 0))
  ).sort((a, b) => a - b);

  const releases: Array<() => void> = [];
  for (const sid of sortedUnique) {
    const rel = await acquireServerLock(sid);
    releases.push(rel);
  }

  return () => {
    for (let i = releases.length - 1; i >= 0; i--) {
      releases[i]();
    }
  };
}

/**
 * Exponential Backoff chuẩn Mục 6.2.2: 1 phút -> 3 phút -> 10 phút -> 30 phút (tối đa 10 lần)
 */
export function getBackoffDelayMs(attemptNumber: number): number {
  const scheduleMinutes = [1, 3, 10, 30, 30, 30, 30, 30, 30, 30];
  const idx = Math.min(
    Math.max(0, attemptNumber - 1),
    scheduleMinutes.length - 1
  );
  return scheduleMinutes[idx] * 60 * 1000;
}

/**
 * N14 Fix: Bao gồm giây (YYYY-MM-DD_HH-mm-ss) kèm bộ đếm chống đụng độ nguyên tử theo từng server,
 * đảm bảo nhiều lần kích hoạt trong cùng một giây không bao giờ sinh trùng tên thư mục Snapshot.
 */
export function formatSnapshotTimestamp(serverId?: number, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

  const key = serverId && serverId > 0 ? Number(serverId) : 0;
  const seqMap = getLastSnapshotSeqMap();
  const prev = seqMap.get(key);
  let seq = prev && prev.base === base ? prev.seq + 1 : 1;

  if (serverId && serverId > 0) {
    const db = getDb();
    const srvRow = db
      .prepare(
        `SELECT s.hostname, v.mount_path
         FROM servers s
         LEFT JOIN storage_volumes v ON v.id = s.assigned_volume_id
         WHERE s.id = ?`
      )
      .get(serverId);
    const checkStmt = db.prepare(
      'SELECT COUNT(*) AS cnt FROM backup_jobs WHERE server_id = ? AND snapshot_name = ?'
    );

    while (seq < 10_000) {
      const candidate = seq === 1 ? base : `${base}-${seq}`;
      const dbExists = Number(checkStmt.get(serverId, candidate)?.cnt || 0) > 0;
      let diskExists = false;
      if (srvRow?.mount_path && srvRow?.hostname) {
        const hostDir = path.join(
          String(srvRow.mount_path),
          String(srvRow.hostname)
        );
        diskExists =
          fs.existsSync(path.join(hostDir, candidate)) ||
          fs.existsSync(path.join(hostDir, `.in_progress_${candidate}`));
      }
      if (!dbExists && !diskExists) {
        seqMap.set(key, { base, seq });
        return candidate;
      }
      seq++;
    }
  }

  seqMap.set(key, { base, seq });
  return seq === 1 ? base : `${base}-${seq}`;
}

async function probeRedisAvailable(redisUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      client.disconnect();
      resolve(ok);
    };
    client.on('error', () => finish(false));
    client
      .connect()
      .then(() => client.ping())
      .then(() => finish(true))
      .catch(() => finish(false));
  });
}

function getJobServerTargets(jobId: number): {
  exists: boolean;
  status: string;
  lockTargets: number[];
} {
  const row = getDb()
    .prepare(
      'SELECT status, server_id, target_server_id FROM backup_jobs WHERE id = ?'
    )
    .get(jobId);
  if (!row) {
    return { exists: false, status: '', lockTargets: [] };
  }
  const targets = [
    Number(row.server_id),
    ...(row.target_server_id ? [Number(row.target_server_id)] : []),
  ].filter((id) => Number.isInteger(id) && id > 0);
  return {
    exists: true,
    status: String(row.status),
    lockTargets: Array.from(new Set(targets)),
  };
}

function completeScheduleBtrfsBatchTracking(
  batchId: string | null | undefined,
  jobId: number
): void {
  if (!batchId) return;
  const batches = getScheduleBtrfsBatchesMap();
  const pendingSet = batches.get(batchId);
  if (!pendingSet) return;
  pendingSet.delete(jobId);
  if (pendingSet.size === 0) {
    batches.delete(batchId);
    void triggerImmutableWormSnapshot().catch((err) => {
      console.warn(
        `[WORM Post-Schedule] Cảnh báo chụp Immutable Snapshot sau lịch sao lưu:`,
        (err as Error).message
      );
    });
  }
}

async function processJobPayload(payload: QueuedTaskPayload): Promise<void> {
  const db = getDb();
  const meta = getJobServerTargets(payload.jobId);

  if (
    !meta.exists ||
    (meta.status !== 'QUEUED' && meta.status !== 'INTERRUPTED')
  ) {
    completeScheduleBtrfsBatchTracking(payload.scheduleBatchId, payload.jobId);
    return;
  }

  // N1 Fix: RESTORE không bao giờ được chạy lại tự động từ trạng thái INTERRUPTED
  if (payload.jobType === 'RESTORE' && meta.status !== 'QUEUED') {
    return;
  }

  const releaseLocks = await acquireMultiServerLocks(meta.lockTargets);
  const executingSet = getActiveExecutingJobsSet();

  try {
    // N1 Fix: Claim trạng thái nguyên tử (Atomic CAS) bên trong Server Lock —
    // chặn tuyệt đối việc job COMPLETED/FAILED/CANCELLED hoặc đang RUNNING bị thực thi lần 2.
    const allowedStatuses =
      payload.jobType === 'RESTORE' ? "('QUEUED')" : "('QUEUED', 'INTERRUPTED')";
    const claimRes = db
      .prepare(
        `UPDATE backup_jobs
         SET status = CASE
               WHEN retry_count > 0 OR status = 'INTERRUPTED' THEN 'RESUMING'
               ELSE 'RUNNING'
             END,
             started_at = COALESCE(started_at, datetime('now'))
         WHERE id = ?
           AND status IN ${allowedStatuses}`
      )
      .run(payload.jobId);

    if (claimRes.changes === 0) {
      return;
    }
    emitJobUpdated(payload.jobId);

    executingSet.add(payload.jobId);
    try {
      if (payload.jobType === 'RESTORE') {
        try {
          await executeRestoreJob(payload.jobId);
        } catch (restoreErr) {
          // N1 Fix: Ném UnrecoverableError để BullMQ tuyệt đối không retry lệnh Restore (--delete) vào site production
          throw new UnrecoverableError(
            (restoreErr as Error)?.message || 'Khôi phục thất bại.'
          );
        }
        return;
      }

      try {
        await executeBackupJob(payload.jobId, { verifyDb: payload.verifyDb });
      } catch (backupErr) {
        const afterErrRow = db
          .prepare('SELECT status, retry_count FROM backup_jobs WHERE id = ?')
          .get(payload.jobId);
        const canRetry =
          backupErr instanceof RetryableNetworkError &&
          afterErrRow?.status === 'INTERRUPTED' &&
          Number(afterErrRow?.retry_count || 0) <= MAX_BACKUP_RETRIES;
        if (canRetry) {
          throw backupErr;
        }
        throw new UnrecoverableError(
          (backupErr as Error)?.message || 'Sao lưu thất bại.'
        );
      }

      if (payload.retentionPolicy) {
        const afterRow = db
          .prepare('SELECT server_id, status FROM backup_jobs WHERE id = ?')
          .get(payload.jobId);
        if (afterRow?.server_id && afterRow.status === 'COMPLETED') {
          await applyGfsRetentionForServer(
            Number(afterRow.server_id),
            payload.retentionPolicy,
            false
          );
        }
      }
    } finally {
      executingSet.delete(payload.jobId);
    }
  } finally {
    releaseLocks();
    completeScheduleBtrfsBatchTracking(payload.scheduleBatchId, payload.jobId);
  }
}

export function drainLocalQueue() {
  const state = getEngineState();
  if (globalThis.__nasSyncUpdating) {
    return;
  }

  while (
    state.localRunningCount < state.localMaxConcurrency &&
    state.localPending.length > 0
  ) {
    // N8 Fix: Kiểm tra khóa máy chủ trước khi chiếm slot concurrency để các job chờ cùng 1 server bận không làm đói server khác
    let pickedIndex = -1;
    for (let i = 0; i < state.localPending.length; i++) {
      const candidate = state.localPending[i];
      const meta = getJobServerTargets(candidate.jobId);
      if (
        !meta.exists ||
        (meta.status !== 'QUEUED' && meta.status !== 'INTERRUPTED')
      ) {
        pickedIndex = i;
        break;
      }
      const anyBusy = meta.lockTargets.some((sid) => isServerLockBusy(sid));
      if (!anyBusy) {
        pickedIndex = i;
        break;
      }
    }

    if (pickedIndex < 0) {
      break;
    }

    const [nextTask] = state.localPending.splice(pickedIndex, 1);
    state.localRunningCount++;

    void (async () => {
      try {
        await processJobPayload(nextTask);
      } catch (err) {
        if (err instanceof RetryableNetworkError) {
          const row = getDb()
            .prepare('SELECT status, retry_count FROM backup_jobs WHERE id = ?')
            .get(nextTask.jobId);
          const retryCount = Number(row?.retry_count || 1);
          if (
            row?.status === 'INTERRUPTED' &&
            retryCount <= MAX_BACKUP_RETRIES
          ) {
            const delayMs = getBackoffDelayMs(retryCount);
            const timer = setTimeout(() => {
              const latest = getDb()
                .prepare('SELECT status FROM backup_jobs WHERE id = ?')
                .get(nextTask.jobId);
              if (
                latest?.status === 'INTERRUPTED' &&
                !state.localPending.some((p) => p.jobId === nextTask.jobId) &&
                !getActiveExecutingJobsSet().has(nextTask.jobId)
              ) {
                state.localPending.push(nextTask);
                drainLocalQueue();
              }
            }, delayMs);
            timer.unref();
          }
        }
      } finally {
        state.localRunningCount--;
        drainLocalQueue();
      }
    })();
  }
}

export async function initializeQueueAndScheduler(): Promise<{
  mode: 'BULLMQ_REDIS' | 'LOCAL_MEMORY';
}> {
  const state = getEngineState();
  if (state.initialized) {
    return { mode: state.mode };
  }
  state.initialized = true;

  const db = getDb();

  // N7 Fix: Đưa các máy chủ bị kẹt trạng thái BACKUP_RUNNING từ phiên crash trước về ONLINE
  db.prepare(
    `UPDATE servers SET status = 'ONLINE' WHERE status = 'BACKUP_RUNNING'`
  ).run();

  // U4 Fix: Dọn dẹp các phiên đồng bộ Offsite bị kẹt ở UPLOADING/QUEUED do tiến trình cũ tắt đột ngột
  db.prepare(
    `UPDATE offsite_sync_jobs
     SET status = 'FAILED',
         error_message = 'Tiến trình đồng bộ đám mây bị ngắt do dịch vụ khởi động lại.',
         completed_at = datetime('now')
     WHERE status IN ('UPLOADING', 'QUEUED')`
  ).run();

  // N1, N4, N7 Fix: Phục hồi an toàn các job đang chạy dở khi container khởi động lại
  const danglingJobs = db
    .prepare(
      `SELECT j.id, j.job_type, j.server_id, j.snapshot_name, j.retry_count, s.hostname
       FROM backup_jobs j
       LEFT JOIN servers s ON s.id = j.server_id
       WHERE j.status IN ('RUNNING', 'RESUMING', 'VERIFYING')`
    )
    .all();

  for (const dj of danglingJobs) {
    const jid = Number(dj.id);
    const jtype = String(dj.job_type);
    const sid = Number(dj.server_id);
    const host = String(dj.hostname || `Server #${sid}`);

    if (jtype === 'RESTORE') {
      const msg =
        'Phiên khôi phục bị ngắt giữa chừng do dịch vụ khởi động lại — đã dừng an toàn để không ghi đè tự động.';
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'FAILED', current_phase = 'Gián đoạn khi khởi động lại',
             completed_at = datetime('now'), error_log = ?
         WHERE id = ?`
      ).run(msg, jid);
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'RESTORE',
        title: `Khôi phục bị ngắt khi khởi động lại (${host})`,
        message: `Restore Job #${jid} bị dừng khi container khởi động lại. Vui lòng kiểm tra máy chủ đích trước khi chạy lại.`,
        serverId: sid || null,
        jobId: jid,
      }).catch(() => {});
      continue;
    }

    const nextRetry = Number(dj.retry_count || 0) + 1;
    if (nextRetry > MAX_BACKUP_RETRIES) {
      const exhaustedMsg = `Đã vượt quá giới hạn ${MAX_BACKUP_RETRIES} lần thử lại (tiến trình liên tục bị ngắt/khởi động lại).`;
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'FAILED', current_phase = 'Thất bại (Quá số lần thử lại)',
             retry_count = ?, completed_at = datetime('now'), error_log = ?
         WHERE id = ?`
      ).run(nextRetry, exhaustedMsg, jid);
      cleanupInProgressSnapshotDirsForJob(jid);
      if (sid > 0) {
        db.prepare(`UPDATE servers SET status = 'ERROR' WHERE id = ?`).run(sid);
      }
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'BACKUP',
        title: `Sao lưu thất bại sau ${MAX_BACKUP_RETRIES} lần thử trên ${host}`,
        message: `Job #${jid} (${String(dj.snapshot_name || '')}) đã hết lượt tự động Resume: ${exhaustedMsg}`,
        serverId: sid || null,
        jobId: jid,
      }).catch(() => {});
    } else {
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'INTERRUPTED', retry_count = ?,
             current_phase = 'Container khởi động lại — Chờ tự động Resume...'
         WHERE id = ?`
      ).run(nextRetry, jid);
    }
  }

  // N4 Fix: Các job INTERRUPTED đã chạm ngưỡng >= MAX_BACKUP_RETRIES từ trước cũng chuyển sang FAILED kèm cảnh báo CRITICAL
  const exhaustedInterrupted = db
    .prepare(
      `SELECT j.id, j.server_id, j.snapshot_name, j.error_log, s.hostname
       FROM backup_jobs j
       LEFT JOIN servers s ON s.id = j.server_id
       WHERE j.status = 'INTERRUPTED' AND j.retry_count >= ?`
    )
    .all(MAX_BACKUP_RETRIES);

  for (const ex of exhaustedInterrupted) {
    const jid = Number(ex.id);
    const sid = Number(ex.server_id);
    const host = String(ex.hostname || `Server #${sid}`);
    const msg = `Đã hết ${MAX_BACKUP_RETRIES} lần tự động thử lại: ${String(
      ex.error_log || 'Không thể kết nối máy chủ.'
    )}`;
    db.prepare(
      `UPDATE backup_jobs
       SET status = 'FAILED', current_phase = 'Thất bại (Hết lượt Resume)',
           completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(msg, jid);
    cleanupInProgressSnapshotDirsForJob(jid);
    if (sid > 0) {
      db.prepare(`UPDATE servers SET status = 'ERROR' WHERE id = ?`).run(sid);
    }
    await createSystemAlert({
      severity: 'CRITICAL',
      category: 'BACKUP',
      title: `Sao lưu thất bại trên ${host} (hết lượt thử lại)`,
      message: `Job #${jid} (${String(ex.snapshot_name || '')}) dừng vĩnh viễn: ${msg}`,
      serverId: sid || null,
      jobId: jid,
    }).catch(() => {});
  }

  // N6 Fix: Dọn dẹp toàn bộ các thư mục .in_progress_* mồ côi trên đĩa
  sweepOrphanedInProgressDirsOnStartup();

  const redisUrl = process.env.REDIS_URL?.trim() || '';
  if (redisUrl && (await probeRedisAvailable(redisUrl))) {
    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    state.bullQueue = new Queue<QueuedTaskPayload>('nas-sync-backup-jobs', {
      connection,
      defaultJobOptions: {
        attempts: MAX_BACKUP_RETRIES,
        backoff: {
          type: 'nas-sync-exponential',
        },
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    });

    const workerConnection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    state.bullWorker = new Worker<QueuedTaskPayload>(
      'nas-sync-backup-jobs',
      async (bullJob, token) => {
        if (globalThis.__nasSyncUpdating && token) {
          await bullJob.moveToDelayed(Date.now() + 10_000, token);
          throw new DelayedError();
        }
        // N8 Fix: Giải phóng ngay worker slot BullMQ nếu server đích của job này đang bận
        const meta = getJobServerTargets(bullJob.data.jobId);
        if (
          token &&
          meta.exists &&
          (meta.status === 'QUEUED' || meta.status === 'INTERRUPTED') &&
          meta.lockTargets.some((sid) => isServerLockBusy(sid))
        ) {
          await bullJob.moveToDelayed(Date.now() + 3_000, token);
          throw new DelayedError();
        }
        await processJobPayload(bullJob.data);
      },
      {
        connection: workerConnection,
        concurrency: 3,
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            getBackoffDelayMs(attemptsMade),
        },
      }
    );

    state.mode = 'BULLMQ_REDIS';
    state.redisUrl = redisUrl;
    const maskedRedis = redisUrl.replace(/\/\/([^@/]+)@/, '//***@');
    console.log(`[NAS-Sync Engine] Hàng đợi BullMQ đã kết nối Redis (${maskedRedis})`);
  } else {
    state.mode = 'LOCAL_MEMORY';
    console.log(
      `[NAS-Sync Engine] Chạy ở chế độ Local Queue Engine (Tương thích chạy trực tiếp không cần Redis)`
    );
  }

  reloadCronSchedules();

  // N7 Fix: Nạp lại cả các Job QUEUED bị mất khỏi RAM khi restart VÀ các Job BACKUP INTERRUPTED còn lượt retry
  const recoverable = db
    .prepare(
      `SELECT id, job_type, status
       FROM backup_jobs
       WHERE status = 'QUEUED'
          OR (status = 'INTERRUPTED' AND job_type = 'BACKUP' AND retry_count < ?)
       ORDER BY id ASC`
    )
    .all(MAX_BACKUP_RETRIES);

  for (const row of recoverable) {
    await dispatchExistingJob(
      Number(row.id),
      String(row.job_type) === 'RESTORE' ? 'RESTORE' : 'BACKUP'
    );
  }

  return { mode: state.mode };
}

export function getQueueRuntimeInfo() {
  const state = getEngineState();
  return {
    initialized: state.initialized,
    mode: state.mode,
    redisConnected: state.mode === 'BULLMQ_REDIS',
    activeSchedulesCount: state.cronTasks.size,
  };
}

export async function enqueueServerBackup(params: {
  serverId: number;
  scheduleId?: number | null;
  verifyDb?: boolean;
  retentionPolicy?: RetentionPolicy | null;
  scheduleBatchId?: string | null;
}): Promise<number> {
  const db = getDb();
  const server = db
    .prepare('SELECT id, assigned_volume_id FROM servers WHERE id = ?')
    .get(params.serverId);

  if (!server) {
    throw new Error(`Không tìm thấy máy chủ ID=${params.serverId}`);
  }

  // N14 Fix: Cấp phát tên Snapshot và INSERT trong cùng giao dịch SQLite để triệt tiêu hoàn toàn race trùng tên
  let jobId: number;
  db.exec('BEGIN IMMEDIATE');
  try {
    const snapshotName = formatSnapshotTimestamp(params.serverId);
    const res = db
      .prepare(
        `INSERT INTO backup_jobs
         (job_type, server_id, schedule_id, volume_id, snapshot_name, status, progress_percent, current_phase)
         VALUES ('BACKUP', ?, ?, ?, ?, 'QUEUED', 0, 'Đang xếp hàng đợi...')`
      )
      .run(
        params.serverId,
        params.scheduleId ?? null,
        (server.assigned_volume_id as number | null) ?? null,
        snapshotName
      );
    jobId = Number(res.lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }

  if (params.scheduleBatchId) {
    const batches = getScheduleBtrfsBatchesMap();
    const set = batches.get(params.scheduleBatchId) || new Set<number>();
    set.add(jobId);
    batches.set(params.scheduleBatchId, set);
  }

  emitJobUpdated(jobId);

  await dispatchExistingJob(jobId, 'BACKUP', {
    verifyDb: params.verifyDb ?? true,
    retentionPolicy: params.retentionPolicy ?? null,
    scheduleBatchId: params.scheduleBatchId ?? null,
  });

  return jobId;
}

export async function enqueueRestoreOperation(
  payload: RestoreRequestPayload
): Promise<number> {
  const db = getDb();
  const item = db
    .prepare('SELECT * FROM backup_items WHERE id = ?')
    .get(payload.backupItemId);
  if (!item) {
    throw new Error('Không tìm thấy bản sao lưu domain cần khôi phục.');
  }

  const enrichedPayload: RestoreRequestPayload = {
    ...payload,
    sourceJobId: payload.sourceJobId || Number(item.job_id),
  };

  const res = db
    .prepare(
      `INSERT INTO backup_jobs
       (job_type, server_id, target_server_id, volume_id, snapshot_name, status, progress_percent, current_phase, current_domain, restore_options)
       VALUES ('RESTORE', ?, ?, ?, ?, 'QUEUED', 0, 'Đang chuẩn bị khôi phục...', ?, ?)`
    )
    .run(
      Number(item.server_id),
      payload.targetServerId,
      Number(item.volume_id),
      String(item.snapshot_name),
      String(item.domain_name),
      JSON.stringify(enrichedPayload)
    );

  const jobId = Number(res.lastInsertRowid);
  emitJobUpdated(jobId);

  await dispatchExistingJob(jobId, 'RESTORE');
  return jobId;
}

export async function dispatchExistingJob(
  jobId: number,
  jobType: 'BACKUP' | 'RESTORE',
  extra: {
    verifyDb?: boolean;
    retentionPolicy?: RetentionPolicy | null;
    scheduleBatchId?: string | null;
  } = {}
): Promise<void> {
  clearCancelledJob(jobId);
  await initializeQueueAndScheduler();
  const state = getEngineState();

  const payload: QueuedTaskPayload = {
    jobId,
    jobType,
    verifyDb: extra.verifyDb ?? true,
    retentionPolicy: extra.retentionPolicy ?? null,
    scheduleBatchId: extra.scheduleBatchId ?? null,
  };

  if (state.mode === 'BULLMQ_REDIS' && state.bullQueue) {
    // N1 Fix: Sử dụng jobId cố định (deterministic) trên BullMQ và attempts=1 cho RESTORE
    const deterministicId = `nas-sync-job-${jobId}`;
    const existingBullJob = await state.bullQueue
      .getJob(deterministicId)
      .catch(() => null);
    if (existingBullJob) {
      const bullState = await existingBullJob.getState().catch(() => '');
      if (bullState === 'active') {
        return;
      }
      await existingBullJob.remove().catch(() => {});
    }

    await state.bullQueue.add(`job-${jobId}`, payload, {
      jobId: deterministicId,
      attempts: jobType === 'RESTORE' ? 1 : MAX_BACKUP_RETRIES,
    });
  } else {
    if (
      !state.localPending.some((p) => p.jobId === jobId) &&
      !getActiveExecutingJobsSet().has(jobId)
    ) {
      state.localPending.push(payload);
    }
    drainLocalQueue();
  }
}

export function cancelRunningOrQueuedJob(jobId: number) {
  const db = getDb();
  const state = getEngineState();
  state.localPending = state.localPending.filter((p) => p.jobId !== jobId);
  requestCancelJob(jobId);

  if (state.bullQueue) {
    const deterministicId = `nas-sync-job-${jobId}`;
    void state.bullQueue
      .getJob(deterministicId)
      .then(async (bj) => {
        if (bj) {
          const st = await bj.getState().catch(() => '');
          if (st !== 'active') {
            await bj.remove().catch(() => {});
          }
        }
      })
      .catch(() => {});

    void state.bullQueue
      .getJobs(['waiting', 'delayed'])
      .then(async (waitingJobs) => {
        for (const bj of waitingJobs) {
          if (bj?.data?.jobId === jobId) {
            await bj.remove().catch(() => {});
          }
        }
      })
      .catch(() => {});
  }

  const job = db
    .prepare('SELECT status, server_id, job_type FROM backup_jobs WHERE id = ?')
    .get(jobId);

  if (!job) return;

  const isActivelyRunning = getActiveExecutingJobsSet().has(jobId);
  const statusStr = String(job.status);

  if (
    statusStr === 'QUEUED' ||
    statusStr === 'INTERRUPTED' ||
    (!isActivelyRunning &&
      (statusStr === 'RUNNING' ||
        statusStr === 'RESUMING' ||
        statusStr === 'VERIFYING'))
  ) {
    db.prepare(
      `UPDATE backup_jobs SET status = 'CANCELLED', current_phase = 'Đã hủy bởi quản trị viên', completed_at = datetime('now') WHERE id = ?`
    ).run(jobId);
    // N6 Fix: Dọn ngay thư mục .in_progress_<snapshot> khi hủy job đang QUEUED/INTERRUPTED
    cleanupInProgressSnapshotDirsForJob(jobId);
    if (job.server_id && String(job.job_type) === 'BACKUP') {
      db.prepare(
        `UPDATE servers SET status = 'ONLINE' WHERE id = ? AND status = 'BACKUP_RUNNING'`
      ).run(Number(job.server_id));
    }
    emitJobUpdated(jobId);
  } else if (
    statusStr === 'RUNNING' ||
    statusStr === 'RESUMING' ||
    statusStr === 'VERIFYING'
  ) {
    db.prepare(
      `UPDATE backup_jobs SET current_phase = 'Đang dừng tiến trình theo yêu cầu quản trị viên...' WHERE id = ?`
    ).run(jobId);
    emitJobUpdated(jobId);
  }
}

export function reloadCronSchedules() {
  const state = getEngineState();
  for (const task of state.cronTasks.values()) {
    task.stop();
  }
  state.cronTasks.clear();

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM backup_schedules WHERE enabled = 1')
    .all();

  for (const r of rows) {
    const sched: BackupSchedule = {
      id: Number(r.id),
      name: String(r.name),
      cron_expression: String(r.cron_expression),
      server_ids: JSON.parse(String(r.server_ids || '[]')),
      max_concurrency: Number(r.max_concurrency || 2),
      retention_policy: JSON.parse(
        String(r.retention_policy || '{"daily":7,"weekly":4,"monthly":6}')
      ),
      verify_db_sandbox: Number(r.verify_db_sandbox) === 1,
      btrfs_snapshot_after: Number(r.btrfs_snapshot_after) === 1,
      enabled: Number(r.enabled) === 1,
      last_run_at: r.last_run_at ? String(r.last_run_at) : null,
      created_at: String(r.created_at),
    };

    if (!cron.validate(sched.cron_expression)) continue;

    state.localMaxConcurrency = Math.max(
      state.localMaxConcurrency,
      sched.max_concurrency
    );

    const task = cron.schedule(sched.cron_expression, async () => {
      // U4 Fix: Không kích hoạt lịch sao lưu mới khi hệ thống đang trong tiến trình cập nhật phiên bản
      if (globalThis.__nasSyncUpdating) {
        console.warn(
          `[Cron Schedule #${sched.id}] Hệ thống đang cập nhật phiên bản — tạm hoãn lịch "${sched.name}".`
        );
        return;
      }

      db.prepare(
        `UPDATE backup_schedules SET last_run_at = datetime('now') WHERE id = ?`
      ).run(sched.id);

      // N17 Fix: Theo dõi đúng tập Job thuộc đợt chạy lịch này để chụp Btrfs WORM ngay khi tất cả Job thực sự kết thúc
      const batchId =
        sched.btrfs_snapshot_after && sched.server_ids.length > 0
          ? `sched-${sched.id}-${Date.now()}`
          : null;

      for (let i = 0; i < sched.server_ids.length; i++) {
        const srvId = sched.server_ids[i];
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        try {
          await enqueueServerBackup({
            serverId: srvId,
            scheduleId: sched.id,
            verifyDb: sched.verify_db_sandbox,
            retentionPolicy: sched.retention_policy,
            scheduleBatchId: batchId,
          });
        } catch (err) {
          console.error(
            `[Cron Schedule #${sched.id}] Không thể tạo job cho Server ${srvId}:`,
            err
          );
        }
      }
    });

    state.cronTasks.set(`schedule-${sched.id}`, task);
  }

  // Lịch chụp OS-Level Immutable WORM Snapshot cố định lúc 06:00 sáng (Mục 9.1) nếu bật tự động
  const wormAuto =
    getSetting('worm_auto_enabled', '') === 'true' ||
    getSetting('btrfs_auto_enabled', 'false') === 'true';
  const wormCron =
    getSetting('worm_cron_time', '') ||
    getSetting('btrfs_cron_time', '0 6 * * *');
  if (wormAuto && cron.validate(wormCron)) {
    const wormTask = cron.schedule(wormCron, () => {
      if (globalThis.__nasSyncUpdating) return;
      void triggerImmutableWormSnapshot();
    });
    state.cronTasks.set('worm-snapshot-daily', wormTask);
  }

  // Lịch chụp thống kê dung lượng ngày cố định lúc 23:55 hằng đêm (v1.4.0 30-Day Storage Trend)
  const snapshotStatsTask = cron.schedule('55 23 * * *', () => {
    try {
      captureDailyStorageSnapshot();
    } catch (err) {
      console.error(
        '[Cron Storage Snapshot] Không thể lưu thống kê dung lượng ngày:',
        err
      );
    }
  });
  state.cronTasks.set('storage-snapshot-daily', snapshotStatsTask);

  // Lịch gửi Báo cáo NOC Buổi sáng (Daily Morning Digest) qua Telegram / Email
  const digestEnabled = getSetting('digest_enabled', 'false') === 'true';
  const digestCron = getSetting('digest_cron_time', '0 7 * * *');
  if (digestEnabled && cron.validate(digestCron)) {
    const digestTask = cron.schedule(digestCron, () => {
      void sendDailyMorningDigest().catch((err) => {
        console.error(
          '[Morning Digest Cron] Lỗi gửi Báo cáo NOC Buổi sáng:',
          err
        );
      });
    });
    state.cronTasks.set('morning-digest-daily', digestTask);
  }
}

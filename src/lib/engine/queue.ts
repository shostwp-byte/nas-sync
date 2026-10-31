import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import cron, { type ScheduledTask } from 'node-cron';
import { getDb, getSetting } from '@/lib/db';
import { emitJobUpdated } from '@/lib/events';
import type { BackupSchedule, RestoreRequestPayload, RetentionPolicy } from '@/types';
import {
  executeBackupJob,
  requestCancelJob,
  RetryableNetworkError,
} from './backup-worker';
import { triggerSynologyBtrfsImmutableSnapshot } from './btrfs-worm';
import { executeRestoreJob } from './restore-worker';
import { applyGfsRetentionForServer } from './retention-gfs';

export interface QueuedTaskPayload {
  jobId: number;
  jobType: 'BACKUP' | 'RESTORE';
  verifyDb?: boolean;
  retentionPolicy?: RetentionPolicy | null;
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
  // eslint-disable-next-line no-var
  var __nasSyncQueueEngine: EngineState | undefined;
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

export function formatSnapshotTimestamp(serverId?: number): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate()
  )}_${pad(now.getHours())}-${pad(now.getMinutes())}`;

  if (serverId) {
    const existing = getDb()
      .prepare(
        'SELECT COUNT(*) AS cnt FROM backup_jobs WHERE server_id = ? AND snapshot_name = ?'
      )
      .get(serverId, base)?.cnt as number;
    if (existing > 0) {
      return `${base}-${pad(now.getSeconds())}`;
    }
  }
  return base;
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

async function processJobPayload(payload: QueuedTaskPayload): Promise<void> {
  if (payload.jobType === 'RESTORE') {
    await executeRestoreJob(payload.jobId);
    return;
  }

  await executeBackupJob(payload.jobId, { verifyDb: payload.verifyDb });

  if (payload.retentionPolicy) {
    const row = getDb()
      .prepare('SELECT server_id FROM backup_jobs WHERE id = ?')
      .get(payload.jobId);
    if (row?.server_id) {
      await applyGfsRetentionForServer(
        Number(row.server_id),
        payload.retentionPolicy,
        false
      );
    }
  }
}

function drainLocalQueue() {
  const state = getEngineState();
  while (
    state.localRunningCount < state.localMaxConcurrency &&
    state.localPending.length > 0
  ) {
    const nextTask = state.localPending.shift()!;
    state.localRunningCount++;

    void (async () => {
      try {
        await processJobPayload(nextTask);
      } catch (err) {
        if (err instanceof RetryableNetworkError) {
          const row = getDb()
            .prepare('SELECT retry_count FROM backup_jobs WHERE id = ?')
            .get(nextTask.jobId);
          const retryCount = Number(row?.retry_count || 1);
          if (retryCount <= 10) {
            const delayMs = getBackoffDelayMs(retryCount);
            setTimeout(() => {
              state.localPending.push(nextTask);
              drainLocalQueue();
            }, delayMs);
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

  // Khôi phục trạng thái các job bị treo dở nếu container vừa khởi động lại
  const db = getDb();
  const danglingJobs = db
    .prepare(
      `SELECT id, job_type FROM backup_jobs WHERE status IN ('RUNNING', 'RESUMING', 'VERIFYING')`
    )
    .all();
  for (const dj of danglingJobs) {
    db.prepare(
      `UPDATE backup_jobs SET status = 'INTERRUPTED', current_phase = 'Container khởi động lại — Chờ tự động Resume...' WHERE id = ?`
    ).run(Number(dj.id));
  }

  const redisUrl = process.env.REDIS_URL?.trim() || '';
  if (redisUrl && (await probeRedisAvailable(redisUrl))) {
    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });

    state.bullQueue = new Queue<QueuedTaskPayload>('nas-sync-backup-jobs', {
      connection,
      defaultJobOptions: {
        attempts: 10,
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
      async (bullJob) => {
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
    console.log(`[NAS-Sync Engine] Hàng đợi BullMQ đã kết nối Redis (${redisUrl})`);
  } else {
    state.mode = 'LOCAL_MEMORY';
    console.log(
      `[NAS-Sync Engine] Chạy ở chế độ Local Queue Engine (Tương thích chạy trực tiếp không cần Redis)`
    );
  }

  reloadCronSchedules();

  // Tự động Resume các Job INTERRUPTED trước đó
  const interrupted = db
    .prepare(
      `SELECT id, job_type FROM backup_jobs WHERE status = 'INTERRUPTED' AND retry_count < 10`
    )
    .all();
  for (const row of interrupted) {
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
    redisUrl: state.redisUrl,
    activeSchedulesCount: state.cronTasks.size,
  };
}

export async function enqueueServerBackup(params: {
  serverId: number;
  scheduleId?: number | null;
  verifyDb?: boolean;
  retentionPolicy?: RetentionPolicy | null;
}): Promise<number> {
  const db = getDb();
  const server = db
    .prepare('SELECT id, assigned_volume_id FROM servers WHERE id = ?')
    .get(params.serverId);

  if (!server) {
    throw new Error(`Không tìm thấy máy chủ ID=${params.serverId}`);
  }

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

  const jobId = Number(res.lastInsertRowid);
  emitJobUpdated(jobId);

  await dispatchExistingJob(jobId, 'BACKUP', {
    verifyDb: params.verifyDb ?? true,
    retentionPolicy: params.retentionPolicy ?? null,
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
      JSON.stringify(payload)
    );

  const jobId = Number(res.lastInsertRowid);
  emitJobUpdated(jobId);

  await dispatchExistingJob(jobId, 'RESTORE');
  return jobId;
}

export async function dispatchExistingJob(
  jobId: number,
  jobType: 'BACKUP' | 'RESTORE',
  extra: { verifyDb?: boolean; retentionPolicy?: RetentionPolicy | null } = {}
): Promise<void> {
  await initializeQueueAndScheduler();
  const state = getEngineState();

  const payload: QueuedTaskPayload = {
    jobId,
    jobType,
    verifyDb: extra.verifyDb ?? true,
    retentionPolicy: extra.retentionPolicy ?? null,
  };

  if (state.mode === 'BULLMQ_REDIS' && state.bullQueue) {
    await state.bullQueue.add(`job-${jobId}`, payload, {
      jobId: `nas-sync-job-${jobId}-${Date.now()}`,
    });
  } else {
    state.localPending.push(payload);
    drainLocalQueue();
  }
}

export function cancelRunningOrQueuedJob(jobId: number) {
  const db = getDb();
  const state = getEngineState();
  state.localPending = state.localPending.filter((p) => p.jobId !== jobId);
  requestCancelJob(jobId);

  const job = db
    .prepare('SELECT status, server_id FROM backup_jobs WHERE id = ?')
    .get(jobId);

  if (job && (job.status === 'QUEUED' || job.status === 'INTERRUPTED')) {
    db.prepare(
      `UPDATE backup_jobs SET status = 'CANCELLED', current_phase = 'Đã hủy bởi quản trị viên', completed_at = datetime('now') WHERE id = ?`
    ).run(jobId);
    if (job.server_id) {
      db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
        Number(job.server_id)
      );
    }
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
      db.prepare(
        `UPDATE backup_schedules SET last_run_at = datetime('now') WHERE id = ?`
      ).run(sched.id);

      for (const srvId of sched.server_ids) {
        try {
          await enqueueServerBackup({
            serverId: srvId,
            scheduleId: sched.id,
            verifyDb: sched.verify_db_sandbox,
            retentionPolicy: sched.retention_policy,
          });
        } catch (err) {
          console.error(
            `[Cron Schedule #${sched.id}] Không thể tạo job cho Server ${srvId}:`,
            err
          );
        }
      }

      if (sched.btrfs_snapshot_after) {
        setTimeout(() => {
          void triggerSynologyBtrfsImmutableSnapshot(7);
        }, 15 * 60 * 1000);
      }
    });

    state.cronTasks.set(`schedule-${sched.id}`, task);
  }

  // Lịch chụp Btrfs WORM cố định lúc 06:00 sáng (Mục 9.1) nếu bật tự động
  const btrfsAuto = getSetting('btrfs_auto_enabled', 'false') === 'true';
  const btrfsCron = getSetting('btrfs_cron_time', '0 6 * * *');
  if (btrfsAuto && cron.validate(btrfsCron)) {
    const wormTask = cron.schedule(btrfsCron, () => {
      void triggerSynologyBtrfsImmutableSnapshot(7);
    });
    state.cronTasks.set('btrfs-worm-daily', wormTask);
  }
}


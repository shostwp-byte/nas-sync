import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress } from '@/lib/events';
import type { BackupJob, InProgressState } from '@/types';

export const STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export class RetryableNetworkError extends Error {
  readonly rsyncExitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'RetryableNetworkError';
    this.rsyncExitCode = exitCode;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __nasSyncCancelledJobIds: Set<number> | undefined;
  // eslint-disable-next-line no-var
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

export function terminateChildGracefully(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const forceTimer = setTimeout(() => {
    try {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    } catch {
      // Ignore if already exited
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
      retryCount: curr.retry_count,
    });
  };
}

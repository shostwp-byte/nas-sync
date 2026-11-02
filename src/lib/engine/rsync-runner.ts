import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildRsyncSshTransport } from '@/lib/ssh';
import type { ServerRecord } from '@/types';
import {
  RetryableNetworkError,
  STREAM_IDLE_TIMEOUT_MS,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

const RETRYABLE_RSYNC_CODES = new Set([10, 12, 23, 30, 35, 255]);

export function parseSpeedToBps(speedStr: string): number {
  const m = speedStr.trim().match(/^([\d.]+)\s*([kKmMgGtT]?)[Bb]\/s$/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  switch (unit) {
    case 'K':
      return Math.round(val * 1024);
    case 'M':
      return Math.round(val * 1024 ** 2);
    case 'G':
      return Math.round(val * 1024 ** 3);
    case 'T':
      return Math.round(val * 1024 ** 4);
    default:
      return Math.round(val);
  }
}

export function parseEtaToSeconds(etaStr: string): number {
  const parts = etaStr.trim().split(':').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

export function parseRsyncStats(stdout: string): {
  filesTotal: number;
  filesChanged: number;
  totalBytes: number;
  deltaBytes: number;
} {
  const numFilesMatch = stdout.match(
    /Number of regular files transferred:\s*([\d,]+)/i
  );
  const totalFilesMatch = stdout.match(/Number of files:\s*([\d,]+)/i);
  const totalSizeMatch = stdout.match(/Total file size:\s*([\d,]+)/i);
  const deltaSizeMatch = stdout.match(
    /Total transferred file size:\s*([\d,]+)/i
  );

  const parseNum = (s?: string) => (s ? Number(s.replace(/,/g, '')) || 0 : 0);

  return {
    filesTotal: parseNum(totalFilesMatch?.[1]),
    filesChanged: parseNum(numFilesMatch?.[1]),
    totalBytes: parseNum(totalSizeMatch?.[1]),
    deltaBytes: parseNum(deltaSizeMatch?.[1]),
  };
}

export function getDirectorySizeAndCount(dirPath: string): {
  totalBytes: number;
  fileCount: number;
} {
  let totalBytes = 0;
  let fileCount = 0;
  if (!fs.existsSync(dirPath)) return { totalBytes: 0, fileCount: 0 };

  const stack = [dirPath];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    const entries = fs.readdirSync(curr, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.rsync-partial') continue;
      const full = path.join(curr, entry.name);
      const st = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        fileCount++;
        totalBytes += st.size;
      }
    }
  }
  return { totalBytes, fileCount };
}

/**
 * Mục 5.2: Thực thi rsync Incremental (--link-dest) kéo mã nguồn từ VPS về NAS
 * kèm bắt luồng --info=progress2 thời gian thực.
 */
export function runRsyncPullDomain(params: {
  jobId: number;
  server: ServerRecord;
  remoteWebroot: string;
  destPublicHtmlDir: string;
  linkDestPublicHtmlDir: string | null;
  excludedSubpaths?: string[];
  customExcludes?: string[];
  onProgress: (pct: number, speedBps: number, etaSec: number) => void;
  onLog: (msg: string) => void;
}): Promise<{
  filesTotal: number;
  filesChanged: number;
  totalBytes: number;
  deltaBytes: number;
}> {
  const {
    jobId,
    server,
    remoteWebroot,
    destPublicHtmlDir,
    linkDestPublicHtmlDir,
    excludedSubpaths,
    customExcludes,
    onProgress,
    onLog,
  } = params;

  fs.mkdirSync(destPublicHtmlDir, { recursive: true });

  const args: string[] = [
    '-az',
    '--delete',
    '--no-devices',
    '--no-specials',
    '--safe-links',
    '--stats',
    '--info=progress2',
    '--partial',
    '--partial-dir=.rsync-partial',
    '--timeout=60',
  ];

  if (excludedSubpaths && excludedSubpaths.length > 0) {
    for (const rel of excludedSubpaths) {
      const cleanRel = rel.replace(/^\/+|\/+$/g, '');
      if (cleanRel && !cleanRel.includes('..')) {
        args.push(`--exclude=/${cleanRel}`);
      }
    }
  }

  if (customExcludes && customExcludes.length > 0) {
    for (const pattern of customExcludes) {
      if (pattern && !pattern.startsWith('-') && !/[\r\n\0]/.test(pattern)) {
        args.push(`--exclude=${pattern}`);
      }
    }
  }

  if (server.bw_limit_kbps && server.bw_limit_kbps > 0) {
    args.push(`--bwlimit=${server.bw_limit_kbps}`);
  }

  if (linkDestPublicHtmlDir && fs.existsSync(linkDestPublicHtmlDir)) {
    args.push(`--link-dest=${linkDestPublicHtmlDir}/`);
  }

  args.push('-e', buildRsyncSshTransport(server));
  args.push('--rsync-path=ionice -c2 -n7 nice -n19 rsync');
  args.push(
    `${server.ssh_user || 'root'}@${server.ip_address}:${remoteWebroot.replace(
      /\/+$/,
      ''
    )}/`,
    `${destPublicHtmlDir.replace(/\/+$/, '')}/`
  );

  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    registerJobChildProcess(jobId, child);

    let fullStdout = '';
    let fullStderr = '';
    let lastEmit = 0;
    let lastActivityAt = Date.now();
    let idleTimedOut = false;

    const cancelWatcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > STREAM_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      const str = chunk.toString('utf8');
      fullStdout += str;
      if (fullStdout.length > 65536) {
        fullStdout = fullStdout.slice(-32768);
      }

      const lines = str.split(/[\r\n]+/);
      for (const line of lines) {
        const m = line.match(
          /([\d,]+)\s+(\d+)%\s+([\d.]+[kKmMgGtT]?B\/s)\s+(\d+:\d+:\d+)/
        );
        if (m) {
          const now = Date.now();
          if (now - lastEmit >= 900) {
            lastEmit = now;
            const pct = Math.min(100, Number(m[2]));
            const speedBps = parseSpeedToBps(m[3]);
            const etaSec = parseEtaToSeconds(m[4]);
            onProgress(pct, speedBps, etaSec);
          }
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      const s = chunk.toString('utf8');
      fullStderr += s;
      if (fullStderr.length > 65536) {
        fullStderr = fullStderr.slice(-32768);
      }
    });

    child.on('error', (err) => {
      clearInterval(cancelWatcher);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(cancelWatcher);
      const exitCode = code ?? 1;

      if (isJobCancelled(jobId)) {
        reject(new Error('Job đã bị hủy bởi quản trị viên.'));
        return;
      }

      if (idleTimedOut) {
        reject(
          new RetryableNetworkError(
            'Tiến trình Rsync không phản hồi dữ liệu quá 30 phút (Idle Timeout).',
            30
          )
        );
        return;
      }

      if (exitCode !== 0 && exitCode !== 24) {
        if (RETRYABLE_RSYNC_CODES.has(exitCode)) {
          reject(
            new RetryableNetworkError(
              `Kết nối Rsync/SSH bị gián đoạn (Mã lỗi ${exitCode}): ${fullStderr.trim()}`,
              exitCode
            )
          );
          return;
        }
        reject(
          new Error(`Rsync thất bại (Mã lỗi ${exitCode}): ${fullStderr.trim()}`)
        );
        return;
      }

      if (exitCode === 24) {
        onLog(
          `[Rsync] Ghi chú: Một số file cache tạm thời tự xóa trên VPS trong lúc đồng bộ (code 24 - an toàn).`
        );
      }

      resolve(parseRsyncStats(fullStdout));
    });
  });
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress, emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  shellSingleQuote,
} from '@/lib/ssh';
import type {
  BackupJob,
  DatabaseBackupInfo,
  DiscoveredDomain,
  DomainMetadataJson,
  InProgressState,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { getPanelAdapter } from './adapters';
import { buildMysqlAuthFlags } from './adapters/base';
import { evaluateBackupAnomaly } from './anomaly-detector';
import { verifyJobDatabasesInSandbox } from './sandbox-verifier';
import {
  ensureActiveVolumeForBackup,
  refreshAllVolumes,
  resolveLatestSnapshotDir,
  updateLatestSymlink,
} from './volume-manager';

export class RetryableNetworkError extends Error {
  readonly rsyncExitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'RetryableNetworkError';
    this.rsyncExitCode = exitCode;
  }
}

const cancelledJobIds = new Set<number>();

export function requestCancelJob(jobId: number) {
  cancelledJobIds.add(jobId);
}

export function isJobCancelled(jobId: number): boolean {
  return cancelledJobIds.has(jobId);
}

const RETRYABLE_RSYNC_CODES = new Set([10, 12, 23, 30, 35, 255]);

function parseSpeedToBps(speedStr: string): number {
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

function parseEtaToSeconds(etaStr: string): number {
  const parts = etaStr.trim().split(':').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}

function getDirectorySizeAndCount(dirPath: string): {
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
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        fileCount++;
        totalBytes += fs.statSync(full).size;
      }
    }
  }
  return { totalBytes, fileCount };
}

function loadOrCreateState(
  stateFilePath: string,
  jobId: number,
  snapshotName: string
): InProgressState {
  if (fs.existsSync(stateFilePath)) {
    try {
      return JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as InProgressState;
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

function saveState(stateFilePath: string, state: InProgressState) {
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Mục 5.2: Thực thi rsync Incremental (--link-dest) kéo mã nguồn từ VPS về NAS
 * kèm bắt luồng --info=progress2 thời gian thực.
 */
function runRsyncPullDomain(params: {
  jobId: number;
  server: ServerRecord;
  remoteWebroot: string;
  destPublicHtmlDir: string;
  linkDestPublicHtmlDir: string | null;
  excludedSubpaths?: string[];
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
    onProgress,
    onLog,
  } = params;

  fs.mkdirSync(destPublicHtmlDir, { recursive: true });

  const args: string[] = [
    '-az',
    '--delete',
    '--stats',
    '--info=progress2',
    '--partial',
    '--partial-dir=.rsync-partial',
    '--timeout=60',
  ];

  if (excludedSubpaths && excludedSubpaths.length > 0) {
    for (const rel of excludedSubpaths) {
      const cleanRel = rel.replace(/^\/+|\/+$/g, '');
      if (cleanRel) {
        args.push(`--exclude=/${cleanRel}`);
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

    let fullStdout = '';
    let fullStderr = '';
    let lastEmit = 0;

    const cancelWatcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        child.kill('SIGTERM');
      }
    }, 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      fullStdout += str;

      // Parse dòng --info=progress2: e.g. "  1,245,184,000  64%   24.50MB/s    0:00:42"
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
      const s = chunk.toString('utf8');
      fullStderr += s;
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

      // Mã lỗi 24 của rsync: "Partial transfer due to vanished source files" (file cache tạm bị xóa khi web đang chạy) -> Hợp lệ
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

      // Phân tích thông số từ cờ --stats (Mục 9.3 Anomaly Detection)
      const numFilesMatch = fullStdout.match(
        /Number of regular files transferred:\s*([\d,]+)/i
      );
      const totalFilesMatch = fullStdout.match(
        /Number of files:\s*([\d,]+)/i
      );
      const totalSizeMatch = fullStdout.match(
        /Total file size:\s*([\d,]+)/i
      );
      const deltaSizeMatch = fullStdout.match(
        /Total transferred file size:\s*([\d,]+)/i
      );

      const parseNum = (s?: string) =>
        s ? Number(s.replace(/,/g, '')) || 0 : 0;

      const filesTotal = parseNum(totalFilesMatch?.[1]);
      const filesChanged = parseNum(numFilesMatch?.[1]);
      const totalBytes = parseNum(totalSizeMatch?.[1]);
      const deltaBytes = parseNum(deltaSizeMatch?.[1]);

      if (exitCode === 24) {
        onLog(
          `[Rsync] Ghi chú: Một số file cache tạm thời tự xóa trên VPS trong lúc đồng bộ (code 24 - an toàn).`
        );
      }

      resolve({
        filesTotal,
        filesChanged,
        totalBytes,
        deltaBytes,
      });
    });
  });
}

/**
 * Mục 5.3: Sao lưu Database không dùng ổ cứng tạm trên VPS (SSH Pipe Streaming + kiểm tra PIPESTATUS)
 */
function runSshStreamDatabaseDump(params: {
  jobId: number;
  server: ServerRecord;
  creds: MysqlAdminCredentials;
  dbName: string;
  destDatabasesDir: string;
  onLog: (msg: string) => void;
}): Promise<{ fileName: string; sizeBytes: number }> {
  const { jobId, server, creds, dbName, destDatabasesDir, onLog } = params;
  fs.mkdirSync(destDatabasesDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const authFlags = buildMysqlAuthFlags(creds);

    // Ưu tiên nén zstd -3 -T1 theo đặc tả; tự động fallback sang gzip -c nếu VPS chưa cài zstd
    const checkZstdArgs = [
      ...buildSshBaseArgs(server),
      `${server.ssh_user || 'root'}@${server.ip_address}`,
      'command -v zstd >/dev/null 2>&1 && echo ZSTD || echo GZIP',
    ];

    const probe = spawn('ssh', checkZstdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let probeOut = '';
    probe.stdout.on('data', (d: Buffer) => {
      probeOut += d.toString('utf8');
    });
    probe.on('error', (err) => reject(err));
    probe.on('close', (pCode) => {
      if (pCode === 255) {
        reject(
          new RetryableNetworkError(
            `Mất kết nối SSH khi chuẩn bị stream DB ${dbName}`,
            255
          )
        );
        return;
      }

      const useZstd = probeOut.trim() === 'ZSTD';
      const ext = useZstd ? 'sql.zst' : 'sql.gz';
      const compCmd = useZstd ? 'zstd -3 -T1 -c' : 'gzip -c';
      const fileName = `${dbName}.${ext}`;
      const outPath = path.join(destDatabasesDir, fileName);
      const tmpOutPath = `${outPath}.part`;

      // Sử dụng bash pipefail / PIPESTATUS trên VPS để đảm bảo mysqldump trả về đúng mã 0.
      // dbName do khách hàng hosting đặt — PHẢI single-quote (dấu "..." vẫn cho $(...) chạy với quyền root).
      const quotedDb = shellSingleQuote(dbName);
      const remoteDumpScript = `bash -o pipefail -c ${shellSingleQuote(
        `(command -v ionice >/dev/null 2>&1 && ionice -c2 -n7 nice -n19 mysqldump ${authFlags} --single-transaction --quick --lock-tables=false --routines --triggers --events ${quotedDb} || nice -n19 mysqldump ${authFlags} --single-transaction --quick --lock-tables=false --routines --triggers --events ${quotedDb}) | ${compCmd}`
      )}`;

      const sshArgs = [
        ...buildSshBaseArgs(server),
        `${server.ssh_user || 'root'}@${server.ip_address}`,
        remoteDumpScript,
      ];

      const outStream = fs.createWriteStream(tmpOutPath);
      const child = spawn('ssh', sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      let writeFailed = false;
      child.stdout.pipe(outStream);
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      // Thiếu listener 'error' thì ENOSPC (Volume NAS đầy) thành uncaught exception
      // và làm sập toàn bộ tiến trình Node cùng mọi Job đang chạy.
      outStream.on('error', (err) => {
        writeFailed = true;
        child.kill('SIGKILL');
        fs.rmSync(tmpOutPath, { force: true });
        reject(new Error(`Ghi file dump DB ${dbName} thất bại: ${err.message}`));
      });

      child.on('error', (err) => {
        outStream.destroy();
        reject(err);
      });

      child.on('close', (code) => {
        if (writeFailed) return;
        outStream.end(() => {
          try {
            finalizeDump(code);
          } catch (err) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(err);
          }
        });
      });

      const finalizeDump = (code: number | null) => {
        if (isJobCancelled(jobId)) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(new Error('Job đã bị hủy bởi quản trị viên.'));
          return;
        }

        if (code === 255) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(
            new RetryableNetworkError(
              `Đứt kết nối SSH giữa chừng khi stream DB ${dbName}: ${stderr.trim()}`,
              255
            )
          );
          return;
        }

        if (code !== 0) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(
            new Error(
              `mysqldump stream cho DB "${dbName}" thất bại (PIPESTATUS code ${code}): ${stderr.trim()}`
            )
          );
          return;
        }

        fs.renameSync(tmpOutPath, outPath);
        const sizeBytes = fs.statSync(outPath).size;
        onLog(
          `[DB Stream] Đã stream trực tiếp ${dbName} ➔ ${fileName} (${(
            sizeBytes / 1024
          ).toFixed(1)} KB, không tốn ổ cứng tạm VPS).`
        );
        resolve({ fileName, sizeBytes });
      };
    });
  });
}

/**
 * Mô phỏng sao lưu thực tế trên ổ cứng Local cho các máy chủ Demo (is_mock = 1),
 * sử dụng Hard Link thật (fs.linkSync) để test Incremental, Explorer, Diff Viewer & Sandbox Verify trên Windows!
 */
async function simulateMockDomainSync(params: {
  jobId: number;
  server: ServerRecord;
  domainInfo: DiscoveredDomain;
  snapshotName: string;
  destPublicHtmlDir: string;
  destDatabasesDir: string;
  linkDestPublicHtmlDir: string | null;
  onProgress: (pct: number, speedBps: number, etaSec: number) => void;
  onLog: (msg: string) => void;
}): Promise<{
  filesTotal: number;
  filesChanged: number;
  totalBytes: number;
  deltaBytes: number;
  dbResults: DatabaseBackupInfo[];
}> {
  const {
    jobId,
    server,
    domainInfo,
    snapshotName,
    destPublicHtmlDir,
    destDatabasesDir,
    linkDestPublicHtmlDir,
    onProgress,
    onLog,
  } = params;

  fs.mkdirSync(destPublicHtmlDir, { recursive: true });
  fs.mkdirSync(path.join(destPublicHtmlDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(destPublicHtmlDir, 'includes'), { recursive: true });
  fs.mkdirSync(destDatabasesDir, { recursive: true });

  const staticFiles: Record<string, string> = {
    '.htaccess': `# BEGIN NAS-Sync Optimized Rewrite\nRewriteEngine On\nRewriteBase /\nRewriteCond %{REQUEST_FILENAME} !-f\nRewriteCond %{REQUEST_FILENAME} !-d\nRewriteRule . /index.php [L]\n# END Rewrite\n`,
    'assets/style.css': `/* Theme stylesheet for ${domainInfo.domain} */\nbody { font-family: system-ui, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }\n.container { max-width: 1200px; margin: 0 auto; padding: 2rem; }\n`,
    'includes/bootstrap.php': `<?php\n// Core bootstrapper for ${domainInfo.domain}\ndefine('APP_ENV', 'production');\ndefine('PANEL_ORIGIN', '${server.panel_type}');\ndefine('SYS_USER', '${domainInfo.systemUser}');\n`,
    'robots.txt': `User-agent: *\nAllow: /\nSitemap: https://${domainInfo.domain}/sitemap.xml\n`,
  };

  // File thay đổi mỗi bản snapshot để test Incremental & Diff Viewer!
  const dynamicFiles: Record<string, string> = {
    'index.php': `<?php\n/**\n * Website: ${domainInfo.domain}\n * Hosted on: ${server.hostname} (${server.panel_type})\n * Snapshot Version: ${snapshotName}\n */\nrequire_once __DIR__ . '/includes/bootstrap.php';\nrequire_once __DIR__ . '/wp-config.php';\n\n$buildVersion = '${snapshotName}';\n$activeVisitors = ${Math.floor(
      120 + Math.random() * 500
    )};\necho "<h1>Welcome to ${domainInfo.domain} — Build " . htmlspecialchars($buildVersion) . "</h1>";\n`,
    'wp-config.php': `<?php\ndefine('DB_NAME', '${
      domainInfo.databases[0]?.name || 'app_db'
    }');\ndefine('DB_USER', '${
      domainInfo.databases[0]?.user || domainInfo.systemUser
    }');\ndefine('DB_HOST', 'localhost');\ndefine('WP_CACHE', true);\ndefine('NAS_SYNC_LAST_RUN', '${new Date().toISOString()}');\n`,
  };

  let filesTotal = 0;
  let filesChanged = 0;
  let totalBytes = 0;
  let deltaBytes = 0;

  const steps = 4;
  for (let s = 1; s <= steps; s++) {
    if (isJobCancelled(jobId)) {
      throw new Error('Job đã bị hủy bởi quản trị viên.');
    }
    await new Promise((r) => setTimeout(r, 260));
    onProgress(
      Math.round((s / steps) * 100),
      18 * 1024 * 1024 + Math.floor(Math.random() * 8 * 1024 * 1024),
      Math.max(1, steps - s)
    );
  }

  // Ghi file tĩnh bằng Hard Link từ bản latest nếu không đổi (mô phỏng chính xác rsync --link-dest)
  for (const [relPath, content] of Object.entries(staticFiles)) {
    filesTotal++;
    const destFile = path.join(destPublicHtmlDir, relPath);
    const prevFile = linkDestPublicHtmlDir
      ? path.join(linkDestPublicHtmlDir, relPath)
      : null;

    if (prevFile && fs.existsSync(prevFile)) {
      try {
        if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
        fs.linkSync(prevFile, destFile);
        const sz = fs.statSync(destFile).size;
        totalBytes += sz;
        continue;
      } catch {
        // Fallback ghi thường nếu khác ổ đĩa
      }
    }
    fs.writeFileSync(destFile, content, 'utf8');
    const sz = Buffer.byteLength(content, 'utf8');
    totalBytes += sz;
    deltaBytes += sz;
    filesChanged++;
  }

  // Ghi file có cập nhật mới (tốn dung lượng thực Delta)
  for (const [relPath, content] of Object.entries(dynamicFiles)) {
    filesTotal++;
    filesChanged++;
    const destFile = path.join(destPublicHtmlDir, relPath);
    fs.writeFileSync(destFile, content, 'utf8');
    const sz = Buffer.byteLength(content, 'utf8');
    totalBytes += sz;
    deltaBytes += sz;
  }

  onLog(
    `[Incremental Sync] ${domainInfo.domain}: Tổng ${filesTotal} files, thay đổi ${filesChanged} files (Hard-linked ${
      filesTotal - filesChanged
    } files từ bản latest).`
  );

  // Tạo file dump SQL nén chuẩn .sql.gz hợp lệ
  const dbResults: DatabaseBackupInfo[] = [];
  for (const dbItem of domainInfo.databases) {
    const sqlContent = `-- NAS-Sync SQL Stream Dump
-- Host: ${server.hostname}    Database: ${dbItem.name}
-- Panel: ${server.panel_type}    Snapshot: ${snapshotName}
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS \`wp_options\` (
  \`option_id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL DEFAULT '',
  \`option_value\` longtext NOT NULL,
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`wp_options\` (\`option_name\`, \`option_value\`) VALUES
('siteurl', 'https://${domainInfo.domain}'),
('blogname', '${domainInfo.domain} Enterprise Portal'),
('snapshot_tag', '${snapshotName}');

CREATE TABLE IF NOT EXISTS \`wp_posts\` (
  \`ID\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`post_title\` text NOT NULL,
  \`post_status\` varchar(20) NOT NULL DEFAULT 'publish',
  PRIMARY KEY (\`ID\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO \`wp_posts\` (\`post_title\`, \`post_status\`) VALUES
('Chào mừng tới hệ thống ${domainInfo.domain}', 'publish'),
('Bản ghi đồng bộ lúc ${new Date().toISOString()}', 'publish');

SET FOREIGN_KEY_CHECKS = 1;
-- Dump completed on ${new Date().toISOString()}
`;
    const compressed = zlib.gzipSync(Buffer.from(sqlContent, 'utf8'));
    const fileName = `${dbItem.name}.sql.gz`;
    const dumpPath = path.join(destDatabasesDir, fileName);
    fs.writeFileSync(dumpPath, compressed);

    totalBytes += compressed.length;
    deltaBytes += compressed.length;

    onLog(
      `[DB Stream] Đã stream trực tiếp ${dbItem.name} ➔ ${fileName} (${(
        compressed.length / 1024
      ).toFixed(2)} KB).`
    );

    dbResults.push({
      name: dbItem.name,
      db_user: dbItem.user,
      file: fileName,
      size_bytes: compressed.length,
    });
  }

  return {
    filesTotal,
    filesChanged,
    totalBytes,
    deltaBytes,
    dbResults,
  };
}

/**
 * Thực thi toàn bộ luồng Sao lưu Cốt lõi cho 1 Job (Mục 5, 6, 7, 9.2, 9.3)
 */
export async function executeBackupJob(
  jobId: number,
  options: { verifyDb?: boolean } = {}
): Promise<void> {
  const db = getDb();
  const job = db
    .prepare('SELECT * FROM backup_jobs WHERE id = ?')
    .get(jobId) as unknown as BackupJob | undefined;

  if (!job) {
    throw new Error(`Không tìm thấy Backup Job #${jobId}`);
  }

  const server = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(job.server_id) as unknown as ServerRecord | undefined;

  if (!server) {
    throw new Error(`Không tìm thấy máy chủ ID=${job.server_id}`);
  }

  cancelledJobIds.delete(jobId);

  const logLines: string[] = job.live_log
    ? job.live_log.split('\n').filter(Boolean)
    : [];

  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const formatted = `[${ts}] ${msg}`;
    logLines.push(formatted);
    if (logLines.length > 250) {
      logLines.splice(0, logLines.length - 250);
    }
    db.prepare('UPDATE backup_jobs SET live_log = ? WHERE id = ?').run(
      logLines.join('\n'),
      jobId
    );
    emitJobLog({
      jobId,
      serverId: server.id,
      hostname: server.hostname,
      line: formatted,
      timestamp: ts,
    });
  };

  const updateProgress = (patch: {
    status?: BackupJob['status'];
    progressPercent?: number;
    currentPhase?: string;
    currentDomain?: string;
    speedBps?: number;
    etaSeconds?: number;
    totalSizeBytes?: number;
    deltaSizeBytes?: number;
  }) => {
    const curr = db
      .prepare('SELECT * FROM backup_jobs WHERE id = ?')
      .get(jobId) as unknown as BackupJob;
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
      serverId: server.id,
      hostname: server.hostname,
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

  const isResuming = job.retry_count > 0 || job.status === 'INTERRUPTED';

  db.prepare(
    `UPDATE backup_jobs
     SET status = ?, started_at = COALESCE(started_at, datetime('now')), error_log = NULL
     WHERE id = ?`
  ).run(isResuming ? 'RESUMING' : 'RUNNING', jobId);

  db.prepare(`UPDATE servers SET status = 'BACKUP_RUNNING' WHERE id = ?`).run(
    server.id
  );
  emitJobUpdated(jobId);

  try {
    appendLog(
      isResuming
        ? `🔄 Tự động nối tiếp (Auto-Resume lần thử #${job.retry_count}) cho máy chủ ${server.hostname} (${server.panel_type})...`
        : `🚀 Bắt đầu phiên sao lưu tập trung cho máy chủ ${server.hostname} (${server.panel_type})...`
    );

    // 1. Pre-flight Multi-Volume Check & Cross-Volume Seeding (Mục 7)
    updateProgress({
      status: isResuming ? 'RESUMING' : 'RUNNING',
      progressPercent: 3,
      currentPhase: 'Kiểm tra dung lượng phân vùng NAS (Pre-Flight)...',
    });

    const activeVolume = await ensureActiveVolumeForBackup(server, appendLog);
    db.prepare('UPDATE backup_jobs SET volume_id = ? WHERE id = ?').run(
      activeVolume.id,
      jobId
    );

    const hostDir = path.join(activeVolume.mount_path, server.hostname);
    const inProgressDir = path.join(
      hostDir,
      `.in_progress_${job.snapshot_name}`
    );
    const finalSnapshotDir = path.join(hostDir, job.snapshot_name);
    fs.mkdirSync(inProgressDir, { recursive: true });

    const latestSnapshotDir = resolveLatestSnapshotDir(hostDir);
    const isFirstBackup = !latestSnapshotDir;

    if (latestSnapshotDir) {
      appendLog(
        `[Incremental] Phát hiện bản latest (${path.basename(
          latestSnapshotDir
        )}) -> Kích hoạt Hard Link (--link-dest).`
      );
    } else {
      appendLog(
        `[Full Base] Chưa có bản sao lưu trước đó cho ${server.hostname} -> Khởi tạo Full Base đầu tiên.`
      );
    }

    const stateFilePath = path.join(inProgressDir, '.state.json');
    const state = loadOrCreateState(stateFilePath, jobId, job.snapshot_name);

    // 2. Khám phá danh sách User, Domain & thông tin MySQL Admin qua Panel Adapter (Mục 4)
    updateProgress({
      status: 'RUNNING',
      progressPercent: 8,
      currentPhase: `Đang quét cấu trúc ${server.panel_type} qua SSH...`,
    });

    const adapter = getPanelAdapter(server);
    const domains = await adapter.discoverDomains(server);
    const mysqlCreds = await adapter.getMysqlAdminCredentials(server);

    db.prepare(
      `UPDATE servers SET last_connected_at = datetime('now') WHERE id = ?`
    ).run(server.id);

    const subCount = domains.filter((d) => d.isSubdomain).length;
    appendLog(
      `[Discovery] Tìm thấy ${domains.length} website (${
        domains.length - subCount
      } domain chính/addon, ${subCount} subdomain) trên máy chủ ${server.hostname}.`
    );

    if (domains.length === 0) {
      appendLog(`[Cảnh báo] Không tìm thấy domain nào trên ${server.hostname}.`);
    }

    let aggTotalBytes = 0;
    let aggDeltaBytes = 0;
    let aggFilesTotal = 0;
    let aggFilesChanged = 0;

    // Xóa danh sách backup_items tạm của lần thử bị ngắt trước (nếu có) để ghi chuẩn xác khi commit
    db.prepare('DELETE FROM backup_items WHERE job_id = ?').run(jobId);

    // 3. Lặp qua từng Domain: Đồng bộ mã nguồn + Stream DB + Lưu metadata.json
    for (let idx = 0; idx < domains.length; idx++) {
      if (isJobCancelled(jobId)) {
        throw new Error('Job đã bị hủy bởi quản trị viên.');
      }

      const dom = domains[idx];
      const basePct = 10 + Math.round((idx / Math.max(1, domains.length)) * 72);
      const spanPct = Math.round(72 / Math.max(1, domains.length));

      const domainNormalizedDir = path.join(
        inProgressDir,
        'home',
        'domains',
        dom.domain
      );
      const destPublicHtmlDir = path.join(domainNormalizedDir, 'public_html');
      const destDatabasesDir = path.join(domainNormalizedDir, 'databases');
      const linkDestPublicHtmlDir = latestSnapshotDir
        ? path.join(latestSnapshotDir, 'home', 'domains', dom.domain, 'public_html')
        : null;

      let domState = state.completedDomains[dom.domain];
      if (!domState) {
        domState = {
          filesSynced: false,
          webrootSizeBytes: 0,
          filesTotal: 0,
          filesChanged: 0,
          deltaBytes: 0,
          completedDbs: {},
        };
        state.completedDomains[dom.domain] = domState;
      }

      if (domState.filesSynced && Object.keys(domState.completedDbs).length >= dom.databases.length) {
        appendLog(
          `[Auto-Resume] ⏭️ Bỏ qua ${dom.domain} (Đã hoàn thành 100% trước khi ngắt mạng).`
        );
      } else {
        updateProgress({
          progressPercent: basePct,
          currentPhase: `Đang sao lưu mã nguồn (${idx + 1}/${domains.length})`,
          currentDomain: dom.domain,
        });

        if (dom.excludedSubpaths && dom.excludedSubpaths.length > 0) {
          appendLog(
            `[Dedup] ${dom.domain}: Tách riêng thư mục con (${dom.excludedSubpaths
              .map((s) => `/${s}`)
              .join(', ')}) sang gói Subdomain độc lập để không tải trùng lặp.`
          );
        }

        if (server.is_mock) {
          const mockRes = await simulateMockDomainSync({
            jobId,
            server,
            domainInfo: dom,
            snapshotName: job.snapshot_name,
            destPublicHtmlDir,
            destDatabasesDir,
            linkDestPublicHtmlDir,
            onProgress: (subPct, speedBps, etaSec) => {
              updateProgress({
                progressPercent: Math.min(
                  85,
                  basePct + Math.round((subPct / 100) * spanPct)
                ),
                speedBps,
                etaSeconds: etaSec,
              });
            },
            onLog: appendLog,
          });

          domState.filesSynced = true;
          domState.webrootSizeBytes = mockRes.totalBytes;
          domState.filesTotal = mockRes.filesTotal;
          domState.filesChanged = mockRes.filesChanged;
          domState.deltaBytes = mockRes.deltaBytes;
          for (const dbi of mockRes.dbResults) {
            domState.completedDbs[dbi.name] = dbi;
          }
          saveState(stateFilePath, state);
        } else {
          // Chế độ Production SSH + Rsync + Zstd Stream
          if (!domState.filesSynced) {
            appendLog(
              `[Rsync] Đồng bộ mã nguồn ${dom.domain} (${dom.webroot})...`
            );
            const syncStats = await runRsyncPullDomain({
              jobId,
              server,
              remoteWebroot: dom.webroot,
              destPublicHtmlDir,
              linkDestPublicHtmlDir,
              excludedSubpaths: dom.excludedSubpaths,
              onProgress: (subPct, speedBps, etaSec) => {
                updateProgress({
                  progressPercent: Math.min(
                    85,
                    basePct + Math.round((subPct / 100) * (spanPct * 0.7))
                  ),
                  speedBps,
                  etaSeconds: etaSec,
                });
              },
              onLog: appendLog,
            });

            const measured =
              syncStats.totalBytes > 0
                ? syncStats.totalBytes
                : getDirectorySizeAndCount(destPublicHtmlDir).totalBytes;

            domState.filesSynced = true;
            domState.webrootSizeBytes = measured;
            domState.filesTotal = syncStats.filesTotal;
            domState.filesChanged = syncStats.filesChanged;
            domState.deltaBytes = syncStats.deltaBytes;
            saveState(stateFilePath, state);
          }

          // Stream từng Database qua SSH Pipe về thẳng NAS (Mục 5.3)
          for (const dbEntry of dom.databases) {
            if (domState.completedDbs[dbEntry.name]) {
              appendLog(
                `[Auto-Resume] ⏭️ Bỏ qua DB ${dbEntry.name} (Đã tải xong trước đó).`
              );
              continue;
            }
            updateProgress({
              currentPhase: `Đang stream Database ${dbEntry.name}`,
              currentDomain: dom.domain,
            });
            const dumpRes = await runSshStreamDatabaseDump({
              jobId,
              server,
              creds: mysqlCreds,
              dbName: dbEntry.name,
              destDatabasesDir,
              onLog: appendLog,
            });
            domState.completedDbs[dbEntry.name] = {
              name: dbEntry.name,
              db_user: dbEntry.user,
              file: dumpRes.fileName,
              size_bytes: dumpRes.sizeBytes,
            };
            domState.deltaBytes += dumpRes.sizeBytes;
            saveState(stateFilePath, state);
          }
        }
      }

      // Ghi file metadata.json chuẩn hóa (Mục 4.2)
      const dbList = Object.values(domState.completedDbs);
      const metadata: DomainMetadataJson = {
        panel_type: server.panel_type,
        hostname: server.hostname,
        domain_name: dom.domain,
        system_user: dom.systemUser,
        original_webroot: dom.webroot,
        php_version: dom.phpVersion,
        is_subdomain: Boolean(dom.isSubdomain),
        parent_domain: dom.parentDomain,
        excluded_subpaths: dom.excludedSubpaths,
        databases: dbList.map((d) => ({
          name: d.name,
          user: d.db_user,
          dump_file: d.file,
          size_bytes: d.size_bytes,
        })),
        snapshot_name: job.snapshot_name,
        backed_up_at: new Date().toISOString(),
      };
      fs.mkdirSync(domainNormalizedDir, { recursive: true });
      fs.writeFileSync(
        path.join(domainNormalizedDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );

      db.prepare(
        `INSERT INTO backup_items
         (job_id, server_id, volume_id, snapshot_name, system_user, domain_name, source_webroot, webroot_backed_up, webroot_size_bytes, databases_list, php_version, is_subdomain, parent_domain, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'UNTESTED')`
      ).run(
        jobId,
        server.id,
        activeVolume.id,
        job.snapshot_name,
        dom.systemUser,
        dom.domain,
        dom.webroot,
        domState.webrootSizeBytes,
        JSON.stringify(dbList),
        dom.phpVersion,
        dom.isSubdomain ? 1 : 0,
        dom.parentDomain || null
      );

      aggTotalBytes +=
        domState.webrootSizeBytes +
        dbList.reduce((acc, item) => acc + item.size_bytes, 0);
      aggDeltaBytes += domState.deltaBytes;
      aggFilesTotal += domState.filesTotal;
      aggFilesChanged += domState.filesChanged;
    }

    // 4. Hoàn tất nguyên tử (Atomic Commit - Mục 6.2.4)
    updateProgress({
      progressPercent: 86,
      currentPhase: 'Đang thực hiện Atomic Commit bản sao lưu...',
      currentDomain: '',
      speedBps: 0,
      etaSeconds: 2,
    });

    // Dọn file trạng thái tạm trước khi khóa thư mục chính thức
    fs.rmSync(stateFilePath, { force: true });
    if (fs.existsSync(finalSnapshotDir)) {
      fs.rmSync(finalSnapshotDir, { recursive: true, force: true });
    }
    fs.renameSync(inProgressDir, finalSnapshotDir);
    await updateLatestSymlink(hostDir, finalSnapshotDir);

    appendLog(
      `[Atomic Commit] Đã chuyển giao nguyên tử sang ${finalSnapshotDir} và cập nhật symlink latest.`
    );

    db.prepare(
      `UPDATE backup_jobs
       SET total_size_bytes = ?, delta_size_bytes = ?, files_total = ?, files_changed = ?
       WHERE id = ?`
    ).run(aggTotalBytes, aggDeltaBytes, aggFilesTotal, aggFilesChanged, jobId);

    // 5. Phân tích bất thường / Ransomware Anomaly Detection (Mục 9.3)
    await evaluateBackupAnomaly({
      jobId,
      server,
      filesTotal: aggFilesTotal,
      filesChanged: aggFilesChanged,
      deltaSizeBytes: aggDeltaBytes,
      isFirstBackup,
      onLog: appendLog,
    });

    // 6. Kiểm thử tính toàn vẹn SQL trên MariaDB Sandbox (Mục 9.2)
    if (options.verifyDb !== false) {
      updateProgress({
        status: 'VERIFYING',
        progressPercent: 92,
        currentPhase: 'Đang nạp thử kiểm định Database trên Sandbox...',
      });
      await verifyJobDatabasesInSandbox(jobId, finalSnapshotDir, appendLog);
    }

    await refreshAllVolumes();

    db.prepare(
      `UPDATE backup_jobs
       SET status = 'COMPLETED', progress_percent = 100, current_phase = 'Hoàn tất 100%',
           current_domain = '', speed_bps = 0, eta_seconds = 0, completed_at = datetime('now')
       WHERE id = ?`
    ).run(jobId);

    db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
      server.id
    );

    appendLog(
      `✅ Sao lưu hoàn tất 100%! Tổng dung lượng bản backup: ${(
        aggTotalBytes /
        1024 ** 2
      ).toFixed(2)} MB | Dung lượng tăng thêm thực tế (Delta): ${(
        aggDeltaBytes /
        1024 ** 2
      ).toFixed(2)} MB.`
    );

    updateProgress({
      status: 'COMPLETED',
      progressPercent: 100,
      currentPhase: 'Hoàn tất sao lưu & kiểm định',
      speedBps: 0,
      etaSeconds: 0,
      totalSizeBytes: aggTotalBytes,
      deltaSizeBytes: aggDeltaBytes,
    });
    emitJobUpdated(jobId);
  } catch (err) {
    if (err instanceof RetryableNetworkError) {
      const nextRetry = job.retry_count + 1;
      appendLog(
        `⚠️ Gián đoạn kết nối mạng: ${err.message}. Hệ thống lưu trạng thái .state.json và chuyển sang INTERRUPTED để tự động nối tiếp (Lần thử ${nextRetry}/10).`
      );
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'INTERRUPTED', current_phase = 'Mất kết nối — Đang chờ tự động Resume...',
             speed_bps = 0, retry_count = ?, error_log = ?
         WHERE id = ?`
      ).run(nextRetry, err.message, jobId);
      db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
        server.id
      );
      emitJobUpdated(jobId);
      throw err;
    }

    const finalStatus = isJobCancelled(jobId) ? 'CANCELLED' : 'FAILED';
    const errMsg = (err as Error).message || 'Lỗi không xác định';
    appendLog(`❌ Phiên sao lưu dừng (${finalStatus}): ${errMsg}`);

    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, current_phase = ?, speed_bps = 0, eta_seconds = 0,
           completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(
      finalStatus,
      finalStatus === 'CANCELLED' ? 'Đã hủy bởi người dùng' : 'Thất bại',
      errMsg,
      jobId
    );

    db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run(
      finalStatus === 'CANCELLED' ? 'ONLINE' : 'ERROR',
      server.id
    );

    if (finalStatus === 'FAILED') {
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'BACKUP',
        title: `Sao lưu thất bại trên máy chủ ${server.hostname}`,
        message: `Job #${jobId} (${job.snapshot_name}) gặp lỗi: ${errMsg}`,
        serverId: server.id,
        jobId,
      });
    }

    emitJobUpdated(jobId);
    throw err;
  } finally {
    cancelledJobIds.delete(jobId);
  }
}


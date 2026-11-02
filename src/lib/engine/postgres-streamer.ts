import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSshBaseArgs, execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type { ServerRecord } from '@/types';
import { assertSafe, isSafeDbName, isSafeSystemUser } from './safe-names';
import {
  RetryableNetworkError,
  STREAM_IDLE_TIMEOUT_MS,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

const RESTORE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Sao lưu PostgreSQL Database không dùng ổ cứng tạm trên VPS (SSH Pipe Streaming + zstd + PIPESTATUS)
 */
export function streamRemotePostgresDumpToZst(params: {
  jobId: number;
  server: ServerRecord;
  dbName: string;
  destZstFile: string;
  onLog?: (msg: string) => void;
}): Promise<{ fileName: string; filePath: string; sizeBytes: number }> {
  const { jobId, server, dbName, destZstFile, onLog } = params;
  const safeDb = assertSafe(isSafeDbName, dbName, 'Tên PostgreSQL Database');

  const parentDir = path.dirname(destZstFile);
  fs.mkdirSync(parentDir, { recursive: true });
  const fileName = path.basename(destZstFile);
  const tmpOutPath = `${destZstFile}.part`;

  return new Promise((resolve, reject) => {
    const innerDumpScript = `if command -v ionice >/dev/null 2>&1 && ionice -c2 -n7 true 2>/dev/null; then IONICE_CMD="ionice -c2 -n7"; else IONICE_CMD=""; fi\n$IONICE_CMD nice -n19 su - postgres -c "pg_dump --no-owner --no-privileges --clean --if-exists '${safeDb}'" | zstd -3 -c`;
    const remoteDumpScript = `bash -o pipefail -c ${shellSingleQuote(innerDumpScript)}`;

    const sshArgs = [
      ...buildSshBaseArgs(server),
      '--',
      `${server.ssh_user || 'root'}@${server.ip_address}`,
      remoteDumpScript,
    ];

    const outStream = fs.createWriteStream(tmpOutPath);
    const child = spawn('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    registerJobChildProcess(jobId, child);

    let stderr = '';
    let writeFailed = false;
    let idleTimedOut = false;
    let lastActivityAt = Date.now();

    const dumpWatcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > STREAM_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', () => {
      lastActivityAt = Date.now();
    });
    child.stdout.pipe(outStream);
    child.stderr.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      stderr += d.toString('utf8');
      if (stderr.length > 65536) {
        stderr = stderr.slice(-32768);
      }
    });

    outStream.on('error', (err) => {
      writeFailed = true;
      clearInterval(dumpWatcher);
      terminateChildGracefully(child);
      fs.rmSync(tmpOutPath, { force: true });
      reject(
        new Error(
          `Ghi file dump PostgreSQL "${safeDb}" thất bại: ${err.message}`
        )
      );
    });

    child.on('error', (err) => {
      clearInterval(dumpWatcher);
      outStream.destroy();
      fs.rmSync(tmpOutPath, { force: true });
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(dumpWatcher);
      if (writeFailed) return;
      outStream.end(() => {
        try {
          if (isJobCancelled(jobId)) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(new Error('Job đã bị hủy bởi quản trị viên.'));
            return;
          }

          if (idleTimedOut) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(
              new RetryableNetworkError(
                `Luồng stream PostgreSQL DB "${safeDb}" không phản hồi dữ liệu quá 30 phút (Idle Timeout).`,
                30
              )
            );
            return;
          }

          if (code === 255) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(
              new RetryableNetworkError(
                `Đứt kết nối SSH giữa chừng khi stream PostgreSQL DB "${safeDb}": ${stderr.trim()}`,
                255
              )
            );
            return;
          }

          if (code !== 0) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(
              new Error(
                `pg_dump stream cho PostgreSQL DB "${safeDb}" thất bại (PIPESTATUS code ${code}): ${stderr.trim()}`
              )
            );
            return;
          }

          const tmpStat = fs.statSync(tmpOutPath, { throwIfNoEntry: false });
          const sizeBytes = tmpStat ? tmpStat.size : 0;
          if (sizeBytes < 8) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(
              new Error(
                `Tệp nén Zstandard cho PostgreSQL DB "${safeDb}" bị rỗng hoặc cắt cụt (${sizeBytes} bytes).`
              )
            );
            return;
          }

          // Kiểm tra magic header Zstandard (0x28 0xb5 0x2f 0xfd)
          const fd = fs.openSync(tmpOutPath, 'r');
          const header = Buffer.alloc(4);
          fs.readSync(fd, header, 0, 4, 0);
          fs.closeSync(fd);

          const validMagic =
            header[0] === 0x28 &&
            header[1] === 0xb5 &&
            header[2] === 0x2f &&
            header[3] === 0xfd;

          if (!validMagic) {
            fs.rmSync(tmpOutPath, { force: true });
            reject(
              new Error(
                `Tệp dump PostgreSQL DB "${safeDb}" không có định dạng nén Zstandard (.zst) hợp lệ.`
              )
            );
            return;
          }

          fs.renameSync(tmpOutPath, destZstFile);
          onLog?.(
            `[PG Stream] Đã stream trực tiếp PostgreSQL ${safeDb} ➔ ${fileName} (${(
              sizeBytes / 1024
            ).toFixed(1)} KB, không tốn ổ cứng tạm VPS).`
          );
          resolve({ fileName, filePath: destZstFile, sizeBytes });
        } catch (err) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(err);
        }
      });
    });
  });
}

/**
 * Khôi phục PostgreSQL Database qua SSH Pipe từ bản nén .sql.zst / .sql.gz trên NAS
 */
export async function streamRestorePostgresOverSsh(params: {
  jobId: number;
  targetServer: ServerRecord;
  dumpFilePath: string;
  targetDbName: string;
  targetDbUser?: string;
}): Promise<void> {
  const { jobId, targetServer, dumpFilePath, targetDbName, targetDbUser } =
    params;

  const safeTargetDb = assertSafe(
    isSafeDbName,
    targetDbName,
    'Tên PostgreSQL Database đích'
  );
  const safeTargetUser = targetDbUser?.trim()
    ? assertSafe(
        isSafeSystemUser,
        targetDbUser.trim(),
        'Tên User PostgreSQL đích'
      )
    : '';

  const checkAndCreateDbCmd = `psql -tc ${shellSingleQuote(
    `SELECT 1 FROM pg_database WHERE datname = '${safeTargetDb}'`
  )} | grep -q 1 || createdb ${shellSingleQuote(safeTargetDb)}`;
  const grantRoleCmd = safeTargetUser
    ? `psql -tc ${shellSingleQuote(
        `SELECT 1 FROM pg_roles WHERE rolname = '${safeTargetUser}'`
      )} | grep -q 1 && psql -c ${shellSingleQuote(
        `GRANT ALL PRIVILEGES ON DATABASE "${safeTargetDb}" TO "${safeTargetUser}";`
      )} || true`
    : '';
  const ensureScript = safeTargetUser
    ? `su - postgres -c ${shellSingleQuote(checkAndCreateDbCmd)}\nsu - postgres -c ${shellSingleQuote(grantRoleCmd)}`
    : `su - postgres -c ${shellSingleQuote(checkAndCreateDbCmd)}`;

  const ensureRes = await execRemoteSSH(targetServer, ensureScript, {
    zeroImpact: true,
  });
  if (ensureRes.code !== 0) {
    throw new Error(
      `Không thể khởi tạo PostgreSQL database đích "${safeTargetDb}": ${ensureRes.stderr.trim()}`
    );
  }

  return new Promise((resolve, reject) => {
    const ext = path.extname(dumpFilePath).toLowerCase();
    const decompCmd =
      ext === '.zst' ? 'zstd -dc' : ext === '.gz' ? 'gzip -dc' : 'cat';

    const remotePsqlCmd = `su - postgres -c "psql -v ON_ERROR_STOP=1 -d '${safeTargetDb}'"`;
    const pipeline = `set -o pipefail; dump="$1"; shift; ${decompCmd} -- "$dump" | ssh "$@"`;

    const child = spawn(
      'bash',
      [
        '-c',
        pipeline,
        'restore-pg',
        dumpFilePath,
        ...buildSshBaseArgs(targetServer),
        '--',
        `${targetServer.ssh_user || 'root'}@${targetServer.ip_address}`,
        remotePsqlCmd,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    registerJobChildProcess(jobId, child);

    let stderr = '';
    let lastActivityAt = Date.now();
    let idleTimedOut = false;

    const watcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > RESTORE_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', () => {
      lastActivityAt = Date.now();
    });
    child.stderr.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      stderr += d.toString('utf8');
      if (stderr.length > 65536) {
        stderr = stderr.slice(-32768);
      }
    });
    child.on('error', (err) => {
      clearInterval(watcher);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watcher);
      if (isJobCancelled(jobId)) {
        reject(new Error('Job khôi phục đã bị hủy bởi quản trị viên.'));
        return;
      }
      if (idleTimedOut) {
        reject(
          new Error(
            `Nạp PostgreSQL Database ${safeTargetDb} quá thời gian chờ 30 phút (Idle Timeout).`
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Nạp PostgreSQL Database "${safeTargetDb}" thất bại (code ${code}): ${stderr.trim()}`
          )
        );
      }
    });
  });
}

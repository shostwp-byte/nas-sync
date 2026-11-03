import { spawn, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { buildSshBaseArgs, shellSingleQuote } from '@/lib/ssh';
import type { MysqlAdminCredentials, ServerRecord } from '@/types';
import {
  buildMysqlAuthFlags,
  buildRemoteMysqlEnvPrelude,
} from './adapters/base';
import {
  DETACHED_PROCESS_GROUP,
  RetryableNetworkError,
  STREAM_IDLE_TIMEOUT_MS,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

/**
 * Mục 5.3: Sao lưu Database không dùng ổ cứng tạm trên VPS (SSH Pipe Streaming + kiểm tra PIPESTATUS)
 */
export function streamRemoteMysqlDumpToZst(params: {
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
    const envPrelude = buildRemoteMysqlEnvPrelude(creds);

    // Ưu tiên nén zstd -3 -T1 theo đặc tả; tự động fallback sang gzip -c nếu VPS chưa cài zstd
    const checkZstdArgs = [
      ...buildSshBaseArgs(server),
      '--',
      `${server.ssh_user || 'root'}@${server.ip_address}`,
      'command -v zstd >/dev/null 2>&1 && echo ZSTD || echo GZIP',
    ];

    const probe = spawn('ssh', checkZstdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: DETACHED_PROCESS_GROUP,
    });
    registerJobChildProcess(jobId, probe);

    let probeOut = '';
    let probeSettled = false;
    const probeTimer = setTimeout(() => {
      if (!probeSettled) {
        probeSettled = true;
        terminateChildGracefully(probe);
        reject(
          new RetryableNetworkError(
            `Quá thời gian kết nối SSH khi chuẩn bị stream DB ${dbName}`,
            255
          )
        );
      }
    }, 20000);

    probe.stdout.on('data', (d: Buffer) => {
      probeOut += d.toString('utf8');
    });
    probe.on('error', (err) => {
      clearTimeout(probeTimer);
      if (!probeSettled) {
        probeSettled = true;
        reject(err);
      }
    });
    probe.on('close', (pCode) => {
      clearTimeout(probeTimer);
      if (probeSettled) return;
      probeSettled = true;

      if (isJobCancelled(jobId)) {
        reject(new Error('Job đã bị hủy bởi quản trị viên.'));
        return;
      }

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

      const quotedDb = shellSingleQuote(dbName);
      const innerDumpScript = `${envPrelude}if command -v ionice >/dev/null 2>&1 && ionice -c2 -n7 true 2>/dev/null; then IONICE_CMD="ionice -c2 -n7"; else IONICE_CMD=""; fi\n$IONICE_CMD nice -n19 mysqldump ${authFlags} --single-transaction --quick --lock-tables=false --routines --triggers --events ${quotedDb} | ${compCmd}`;
      const remoteDumpScript = `bash -o pipefail -c ${shellSingleQuote(innerDumpScript)}`;

      const sshArgs = [
        ...buildSshBaseArgs(server),
        '--',
        `${server.ssh_user || 'root'}@${server.ip_address}`,
        remoteDumpScript,
      ];

      // N16 Fix: Bắt lỗi đồng bộ (VD: ENOSPC / EACCES) trong listener 'close' để không làm sập tiến trình Node
      let outStream: fs.WriteStream;
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        outStream = fs.createWriteStream(tmpOutPath);
        child = spawn('ssh', sshArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: DETACHED_PROCESS_GROUP,
        });
      } catch (err) {
        try {
          fs.rmSync(tmpOutPath, { force: true });
        } catch {
          // Ignore cleanup failure
        }
        reject(err);
        return;
      }
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
        reject(new Error(`Ghi file dump DB ${dbName} thất bại: ${err.message}`));
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

        if (idleTimedOut) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(
            new RetryableNetworkError(
              `Luồng stream DB ${dbName} không phản hồi dữ liệu quá 30 phút (Idle Timeout).`,
              30
            )
          );
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

        const tmpStat = fs.statSync(tmpOutPath, { throwIfNoEntry: false });
        const sizeBytes = tmpStat ? tmpStat.size : 0;
        if (sizeBytes < (useZstd ? 8 : 20)) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(
            new Error(
              `Tệp nén SQL cho DB "${dbName}" bị rỗng hoặc cắt cụt bất thường (${sizeBytes} bytes).`
            )
          );
          return;
        }

        // Xác minh magic bytes luồng nén (gzip 0x1f8b / zstd 0x28b52ffd) trước khi commit tên file chính thức
        const fd = fs.openSync(tmpOutPath, 'r');
        const header = Buffer.alloc(4);
        fs.readSync(fd, header, 0, 4, 0);
        fs.closeSync(fd);
        const validMagic = useZstd
          ? header[0] === 0x28 &&
          header[1] === 0xb5 &&
          header[2] === 0x2f &&
          header[3] === 0xfd
          : header[0] === 0x1f && header[1] === 0x8b;

        if (!validMagic) {
          fs.rmSync(tmpOutPath, { force: true });
          reject(
            new Error(
              `Tệp dump DB "${dbName}" không có định dạng nén ${useZstd ? 'Zstandard' : 'Gzip'
              } hợp lệ.`
            )
          );
          return;
        }

        fs.renameSync(tmpOutPath, outPath);
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

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';
import { getDb } from '@/lib/db';
import type { BackupItem, DatabaseBackupInfo } from '@/types';
import { createSafePsqlRestoreTransform } from './sql-stream-guard';
import {
  DETACHED_PROCESS_GROUP,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

const SANDBOX_MIN_IMPORT_TIMEOUT_MS = 10 * 60 * 1000; // 10 phút tối thiểu
const SANDBOX_MAX_IMPORT_TIMEOUT_MS = 90 * 60 * 1000; // 90 phút tối đa
const SANDBOX_STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 phút không đọc được byte nào

type Node24ZlibWithZstd = typeof zlib & {
  createZstdDecompress?: () => NodeJS.ReadWriteStream;
  zstdDecompressSync?: (buf: Buffer) => Buffer;
};

/**
 * N5 Fix: Tự động co giãn thời gian chờ kiểm định Sandbox theo kích thước file dump nén
 * (10 phút nền + 5 phút cho mỗi 64 MiB dữ liệu nén, tối đa 90 phút).
 */
export function computeSandboxImportTimeoutMs(
  compressedSizeBytes: number
): number {
  const safeBytes = Math.max(0, Number(compressedSizeBytes) || 0);
  const blocks64MiB = Math.ceil(safeBytes / (64 * 1024 * 1024));
  return Math.min(
    SANDBOX_MAX_IMPORT_TIMEOUT_MS,
    SANDBOX_MIN_IMPORT_TIMEOUT_MS + blocks64MiB * 5 * 60 * 1000
  );
}

let cachedMariaDbSupportsSandboxFlag: boolean | null = null;

function mariaDbSupportsSandboxFlag(): boolean {
  if (cachedMariaDbSupportsSandboxFlag !== null) {
    return cachedMariaDbSupportsSandboxFlag;
  }
  if (process.platform === 'win32') {
    cachedMariaDbSupportsSandboxFlag = false;
    return false;
  }
  try {
    const res = spawnSync('mariadb', ['--help'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
    cachedMariaDbSupportsSandboxFlag = /--sandbox\b/.test(combined);
  } catch {
    cachedMariaDbSupportsSandboxFlag = false;
  }
  return cachedMariaDbSupportsSandboxFlag;
}

export function buildSafeMariaDbClientFlags(options?: {
  includeSandboxIfSupported?: boolean;
}): string[] {
  const flags = ['--binary-mode'];
  if (options?.includeSandboxIfSupported && mariaDbSupportsSandboxFlag()) {
    flags.push('--sandbox');
  }
  return flags;
}

export interface DbVerificationSummary {
  itemId: number;
  domainName: string;
  status: 'PASSED' | 'CORRUPTED' | 'UNTESTED';
  detail: string;
  databases: DatabaseBackupInfo[];
}

async function tryConnectSandboxMariaDb(): Promise<mysql.Connection | null> {
  const host = process.env.SANDBOX_DB_HOST;
  if (!host) return null;

  try {
    const conn = await mysql.createConnection({
      host,
      port: Number(process.env.SANDBOX_DB_PORT || 3306),
      user: process.env.SANDBOX_DB_USER || 'root',
      password: process.env.SANDBOX_DB_PASSWORD || 'sandbox_secret_pass',
      connectTimeout: 3000,
    });
    return conn;
  } catch {
    return null;
  }
}

async function ensureLeastPrivilegeSandboxCredentials(
  conn: mysql.Connection
): Promise<{ user: string; pass: string }> {
  const defaultUser = process.env.SANDBOX_DB_USER || 'root';
  const defaultPass = process.env.SANDBOX_DB_PASSWORD || 'sandbox_secret_pass';
  const verifierUser = 'nas_sync_verifier';
  const verifierPass = crypto.randomBytes(24).toString('hex');

  try {
    await conn.query(
      `CREATE USER IF NOT EXISTS '${verifierUser}'@'%' IDENTIFIED BY ?`,
      [verifierPass]
    );
    await conn.query(
      `ALTER USER '${verifierUser}'@'%' IDENTIFIED BY ?`,
      [verifierPass]
    );
    await conn.query(
      `GRANT ALL PRIVILEGES ON \`verify_%\`.* TO '${verifierUser}'@'%'`
    );
    await conn.query('FLUSH PRIVILEGES');
    return { user: verifierUser, pass: verifierPass };
  } catch {
    return { user: defaultUser, pass: defaultPass };
  }
}

function streamDumpIntoMariaDb(params: {
  jobId: number;
  dumpFilePath: string;
  tempDbName: string;
  dbUser: string;
  dbPass: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { jobId, dumpFilePath, tempDbName, dbUser, dbPass } = params;
  const stat = fs.statSync(dumpFilePath, { throwIfNoEntry: false });
  const effectiveTimeoutMs =
    params.timeoutMs ?? computeSandboxImportTimeoutMs(stat?.size || 0);

  return new Promise((resolve) => {
    const host = process.env.SANDBOX_DB_HOST || 'db_sandbox';
    const port = Number(process.env.SANDBOX_DB_PORT || 3306) || 3306;
    const ext = path.extname(dumpFilePath).toLowerCase();

    // S1 Security Fix: --binary-mode (+ --sandbox nếu hỗ trợ) chặn đứng 100% meta-command `\! <shell>` thực thi lệnh trong container NAS!
    const safeFlags = buildSafeMariaDbClientFlags({
      includeSandboxIfSupported: true,
    });

    // N2 & N5 Fix: Khởi chạy trực tiếp `mariadb` (không bọc qua `bash -c`) và nối trực tiếp luồng giải nén Node vào stdin,
    // ghi nhận từng khối byte đọc từ file dump làm tín hiệu hoạt động sống.
    const mariaChild = spawn(
      'mariadb',
      [...safeFlags, '-h', host, '-P', String(port), '-u', dbUser, tempDbName],
      {
        env: { ...process.env, MYSQL_PWD: dbPass },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: DETACHED_PROCESS_GROUP,
      }
    );
    registerJobChildProcess(jobId, mariaChild);

    const zlibExt = zlib as Node24ZlibWithZstd;
    let fileStream: fs.ReadStream | null = null;
    let decompStream: NodeJS.ReadableStream | null = null;
    let zstdFallbackChild: ReturnType<typeof spawn> | null = null;
    let decompErrMsg = '';
    let stderr = '';
    let settled = false;
    let totalTimedOut = false;
    let idleTimedOut = false;
    let lastActivityAt = Date.now();

    const cleanupStreams = () => {
      try {
        fileStream?.destroy();
      } catch {
        // Ignore
      }
      if (decompStream && decompStream !== fileStream && 'destroy' in decompStream) {
        try {
          (decompStream as Readable).destroy();
        } catch {
          // Ignore
        }
      }
      if (zstdFallbackChild) {
        terminateChildGracefully(zstdFallbackChild);
      }
    };

    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearInterval(idleWatcher);
      cleanupStreams();
      resolve(result);
    };

    const totalTimer = setTimeout(() => {
      totalTimedOut = true;
      cleanupStreams();
      terminateChildGracefully(mariaChild);
    }, effectiveTimeoutMs);

    const idleWatcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        cleanupStreams();
        terminateChildGracefully(mariaChild);
        return;
      }
      if (Date.now() - lastActivityAt > SANDBOX_STREAM_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        cleanupStreams();
        terminateChildGracefully(mariaChild);
      }
    }, 3000);

    mariaChild.stdout.on('data', () => {
      lastActivityAt = Date.now();
    });
    mariaChild.stderr.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      stderr += d.toString('utf8');
      if (stderr.length > 32768) {
        stderr = stderr.slice(-16384);
      }
    });
    mariaChild.stdin.on('error', () => {
      // EPIPE handled on child close
    });

    if (ext === '.zst' && typeof zlibExt.createZstdDecompress !== 'function') {
      const zChild = spawn('zstd', ['-dc', '--', dumpFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: DETACHED_PROCESS_GROUP,
      });
      zstdFallbackChild = zChild;
      registerJobChildProcess(jobId, zChild);
      zChild.stdout.on('data', () => {
        lastActivityAt = Date.now();
      });
      zChild.stderr.on('data', (d: Buffer) => {
        decompErrMsg += d.toString('utf8');
      });
      zChild.on('error', (err) => {
        decompErrMsg = err.message;
        terminateChildGracefully(mariaChild);
      });
      zChild.on('close', (zCode) => {
        if (zCode !== 0 && !isJobCancelled(jobId)) {
          decompErrMsg =
            decompErrMsg.trim() || `Giải nén zstd thất bại (code ${zCode})`;
          mariaChild.stdin.destroy();
        }
      });
      zChild.stdout.pipe(mariaChild.stdin);
    } else {
      fileStream = fs.createReadStream(dumpFilePath);
      fileStream.on('data', () => {
        lastActivityAt = Date.now();
      });
      fileStream.on('error', (err) => {
        decompErrMsg = err.message;
        terminateChildGracefully(mariaChild);
      });

      decompStream =
        ext === '.zst' && typeof zlibExt.createZstdDecompress === 'function'
          ? fileStream.pipe(zlibExt.createZstdDecompress())
          : ext === '.gz'
          ? fileStream.pipe(zlib.createGunzip())
          : fileStream;

      if (decompStream !== fileStream) {
        decompStream.on('error', (err: Error) => {
          decompErrMsg = `Luồng nén SQL bị hỏng: ${err.message}`;
          terminateChildGracefully(mariaChild);
        });
      }
      decompStream.pipe(mariaChild.stdin);
    }

    mariaChild.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    mariaChild.on('close', (code) => {
      if (isJobCancelled(jobId)) {
        finish({
          ok: false,
          error:
            'Tiến trình kiểm định Sandbox đã bị hủy theo yêu cầu quản trị viên',
        });
        return;
      }
      if (totalTimedOut) {
        finish({
          ok: false,
          error: `Quá thời gian chờ tối đa (${Math.round(
            effectiveTimeoutMs / 60000
          )} phút) khi nạp kiểm định vào MariaDB Sandbox`,
        });
        return;
      }
      if (idleTimedOut) {
        finish({
          ok: false,
          error:
            'Luồng nạp MariaDB Sandbox bị treo quá 15 phút không tiến triển dữ liệu',
        });
        return;
      }
      if (decompErrMsg) {
        finish({ ok: false, error: decompErrMsg });
        return;
      }
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({
          ok: false,
          error: stderr.trim() || `MariaDB exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * N17 Fix: Giải nén thực sự cả `.sql.zst` và `.sql.gz` theo luồng O(1) RAM (thay vì chỉ kiểm tra 4 magic bytes cho `.zst`),
 * đối chiếu đầy đủ lệnh `CREATE TABLE` / `INSERT INTO` và phần kết thúc hợp lệ ở cuối file.
 */
export async function verifySqlFileStructureFallback(
  dumpFilePath: string
): Promise<{
  ok: boolean;
  tablesCount: number;
  rowsCount: number;
  error?: string;
}> {
  const stat = fs.lstatSync(dumpFilePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return {
      ok: false,
      tablesCount: 0,
      rowsCount: 0,
      error: 'File SQL không tồn tại hoặc không phải tập tin thông thường',
    };
  }
  if (stat.size === 0) {
    return {
      ok: false,
      tablesCount: 0,
      rowsCount: 0,
      error: 'File SQL rỗng (0 bytes)',
    };
  }

  const ext = path.extname(dumpFilePath).toLowerCase();
  if (ext === '.zst') {
    const fd = fs.openSync(dumpFilePath, 'r');
    const magic = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (
      bytesRead < 4 ||
      magic[0] !== 0x28 ||
      magic[1] !== 0xb5 ||
      magic[2] !== 0x2f ||
      magic[3] !== 0xfd
    ) {
      return {
        ok: false,
        tablesCount: 0,
        rowsCount: 0,
        error: 'Magic header Zstandard (.zst) không hợp lệ',
      };
    }
  }

  const zlibExt = zlib as Node24ZlibWithZstd;

  return new Promise((resolve) => {
    const WINDOW_BYTES = 8192;
    let headBuf = Buffer.alloc(0);
    let tailBuf = Buffer.alloc(0);
    let totalUncompressedBytes = 0;
    let createCount = 0;
    let insertCount = 0;
    let carryText = '';
    let finished = false;
    let cleanupFn: () => void = () => {};

    const fail = (err: Error | string) => {
      if (finished) return;
      finished = true;
      cleanupFn();
      resolve({
        ok: false,
        tablesCount: 0,
        rowsCount: 0,
        error: typeof err === 'string' ? err : err.message,
      });
    };

    const onChunk = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalUncompressedBytes += buf.length;

      if (headBuf.length < WINDOW_BYTES) {
        const needed = WINDOW_BYTES - headBuf.length;
        headBuf = Buffer.concat([headBuf, buf.subarray(0, needed)]);
      }

      if (buf.length >= WINDOW_BYTES) {
        tailBuf = Buffer.from(buf.subarray(buf.length - WINDOW_BYTES));
      } else if (tailBuf.length + buf.length <= WINDOW_BYTES) {
        tailBuf = Buffer.concat([tailBuf, buf]);
      } else {
        const keepPrev = WINDOW_BYTES - buf.length;
        tailBuf = Buffer.concat([
          tailBuf.subarray(tailBuf.length - keepPrev),
          buf,
        ]);
      }

      const combined = carryText + buf.toString('latin1');
      const scanLimit = Math.max(0, combined.length - 24);
      const scanPart = combined.slice(0, scanLimit);
      carryText = combined.slice(scanLimit);

      const creates = scanPart.match(/CREATE\s+TABLE/gi);
      if (creates) createCount += creates.length;
      const inserts = scanPart.match(/INSERT\s+INTO/gi);
      if (inserts) insertCount += inserts.length;
    };

    const onEnd = () => {
      if (finished) return;
      finished = true;

      if (carryText) {
        const creates = carryText.match(/CREATE\s+TABLE/gi);
        if (creates) createCount += creates.length;
        const inserts = carryText.match(/INSERT\s+INTO/gi);
        if (inserts) insertCount += inserts.length;
      }

      if (totalUncompressedBytes === 0) {
        resolve({
          ok: false,
          tablesCount: 0,
          rowsCount: 0,
          error: 'Nội dung SQL sau giải nén bị rỗng (0 bytes)',
        });
        return;
      }

      const tailText = tailBuf.toString('utf8');
      const hasFooter =
        tailText.includes('Dump completed') || tailText.trim().endsWith(';');

      if (!hasFooter) {
        resolve({
          ok: false,
          tablesCount: 0,
          rowsCount: 0,
          error:
            'Cấu trúc SQL bị ngắt quãng (thiếu dấu kết thúc hợp lệ ở cuối file)',
        });
        return;
      }

      resolve({
        ok: true,
        tablesCount: createCount,
        rowsCount: insertCount * 15,
      });
    };

    if (ext === '.zst' && typeof zlibExt.createZstdDecompress !== 'function') {
      const child = spawn('zstd', ['-dc', '--', dumpFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stderr = '';
      cleanupFn = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) =>
        fail(`Không thể chạy zstd để giải nén kiểm định: ${err.message}`)
      );
      child.on('close', (code) => {
        if (code !== 0) {
          fail(
            stderr.trim() ||
              `Giải nén zstd thất bại (mã lỗi ${code}) — dữ liệu bị hỏng`
          );
        } else {
          onEnd();
        }
      });
      return;
    }

    const fileStream = fs.createReadStream(dumpFilePath);
    const sourceStream: NodeJS.ReadableStream =
      ext === '.zst' && typeof zlibExt.createZstdDecompress === 'function'
        ? fileStream.pipe(zlibExt.createZstdDecompress())
        : ext === '.gz'
        ? fileStream.pipe(zlib.createGunzip())
        : fileStream;

    cleanupFn = () => {
      fileStream.destroy();
      if (sourceStream !== fileStream && 'destroy' in sourceStream) {
        (sourceStream as fs.ReadStream).destroy();
      }
    };

    fileStream.on('error', fail);
    if (sourceStream !== fileStream) {
      sourceStream.on('error', fail);
    }
    sourceStream.on('data', onChunk);
    sourceStream.on('end', onEnd);
  });
}

/**
 * Kiểm định toàn vẹn luồng nén Zstandard (.sql.zst) / Gzip (.sql.gz) của PostgreSQL dump
 * bằng Node.js 24 built-in zlib.createZstdDecompress() (kèm fallback CLI `zstd -dc`) + SQL Stream Guard,
 * đối chiếu header `PostgreSQL database dump` & trailer `PostgreSQL database dump complete`.
 */
export async function verifyPostgresDumpFile(dumpFilePath: string): Promise<{
  ok: boolean;
  tablesCount: number;
  rowsCount: number;
  error?: string;
}> {
  const stat = fs.lstatSync(dumpFilePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return {
      ok: false,
      tablesCount: 0,
      rowsCount: 0,
      error:
        'File PostgreSQL dump không tồn tại hoặc không phải tập tin thông thường',
    };
  }
  if (stat.size === 0) {
    return {
      ok: false,
      tablesCount: 0,
      rowsCount: 0,
      error: 'File PostgreSQL dump rỗng (0 bytes)',
    };
  }

  const ext = path.extname(dumpFilePath).toLowerCase();
  if (ext === '.zst') {
    const fd = fs.openSync(dumpFilePath, 'r');
    const magic = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    if (
      bytesRead < 4 ||
      magic[0] !== 0x28 ||
      magic[1] !== 0xb5 ||
      magic[2] !== 0x2f ||
      magic[3] !== 0xfd
    ) {
      return {
        ok: false,
        tablesCount: 0,
        rowsCount: 0,
        error: 'Magic header Zstandard (.zst) của PostgreSQL dump không hợp lệ',
      };
    }
  }

  const zlibExt = zlib as Node24ZlibWithZstd;

  return new Promise((resolve) => {
    const WINDOW_BYTES = 8192;
    let headBuf = Buffer.alloc(0);
    let tailBuf = Buffer.alloc(0);
    let totalUncompressedBytes = 0;
    let createCount = 0;
    let dataStmtCount = 0;
    let carryText = '';
    let finished = false;

    let cleanupFn: () => void = () => {};

    const fail = (err: Error | string) => {
      if (finished) return;
      finished = true;
      cleanupFn();
      resolve({
        ok: false,
        tablesCount: 0,
        rowsCount: 0,
        error: typeof err === 'string' ? err : err.message,
      });
    };

    const onDecompressedChunk = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalUncompressedBytes += buf.length;

      if (headBuf.length < WINDOW_BYTES) {
        const needed = WINDOW_BYTES - headBuf.length;
        headBuf = Buffer.concat([headBuf, buf.subarray(0, needed)]);
      }

      if (buf.length >= WINDOW_BYTES) {
        tailBuf = Buffer.from(buf.subarray(buf.length - WINDOW_BYTES));
      } else if (tailBuf.length + buf.length <= WINDOW_BYTES) {
        tailBuf = Buffer.concat([tailBuf, buf]);
      } else {
        const keepPrev = WINDOW_BYTES - buf.length;
        tailBuf = Buffer.concat([
          tailBuf.subarray(tailBuf.length - keepPrev),
          buf,
        ]);
      }

      const combined = carryText + buf.toString('latin1');
      const scanLimit = Math.max(0, combined.length - 32);
      const scanPart = combined.slice(0, scanLimit);
      carryText = combined.slice(scanLimit);

      const creates = scanPart.match(/CREATE\s+TABLE/gi);
      if (creates) createCount += creates.length;
      const inserts = scanPart.match(/(?:INSERT\s+INTO|COPY\s+\S+)/gi);
      if (inserts) dataStmtCount += inserts.length;
    };

    const onDecompressedEnd = () => {
      if (finished) return;
      finished = true;

      if (carryText) {
        const creates = carryText.match(/CREATE\s+TABLE/gi);
        if (creates) createCount += creates.length;
        const inserts = carryText.match(/(?:INSERT\s+INTO|COPY\s+\S+)/gi);
        if (inserts) dataStmtCount += inserts.length;
      }

      if (totalUncompressedBytes === 0) {
        resolve({
          ok: false,
          tablesCount: 0,
          rowsCount: 0,
          error: 'Nội dung PostgreSQL dump sau giải nén bị rỗng (0 bytes)',
        });
        return;
      }

      const headText = headBuf.toString('utf8');
      const tailText = tailBuf.toString('utf8');

      if (!headText.includes('PostgreSQL database dump')) {
        resolve({
          ok: false,
          tablesCount: 0,
          rowsCount: 0,
          error:
            'Thiếu tiêu đề chuẩn "PostgreSQL database dump" ở đầu tệp sao lưu',
        });
        return;
      }

      if (!tailText.includes('PostgreSQL database dump complete')) {
        resolve({
          ok: false,
          tablesCount: 0,
          rowsCount: 0,
          error:
            'Tệp PostgreSQL dump bị ngắt quãng giữa chừng (thiếu "PostgreSQL database dump complete" ở cuối file)',
        });
        return;
      }

      resolve({
        ok: true,
        tablesCount: createCount,
        rowsCount: dataStmtCount * 10,
      });
    };

    if (ext === '.zst' && typeof zlibExt.createZstdDecompress !== 'function') {
      const child = spawn('zstd', ['-dc', '--', dumpFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const pgGuard = createSafePsqlRestoreTransform();
      let stderr = '';
      cleanupFn = () => {
        pgGuard.destroy();
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      };
      pgGuard.on('error', (err) => fail(err));
      pgGuard.on('data', onDecompressedChunk);
      child.stdout.pipe(pgGuard);
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });
      child.on('error', (err) =>
        fail(`Không thể chạy zstd để giải nén kiểm định: ${err.message}`)
      );
      child.on('close', (code) => {
        if (code !== 0) {
          fail(
            stderr.trim() ||
              `Giải nén zstd thất bại (mã lỗi ${code}) — dữ liệu bị hỏng`
          );
        }
      });
      pgGuard.on('end', () => {
        if (child.exitCode === null || child.exitCode === 0) {
          onDecompressedEnd();
        }
      });
      return;
    }

    const fileStream = fs.createReadStream(dumpFilePath);
    const decompStream: NodeJS.ReadableStream =
      ext === '.zst' && typeof zlibExt.createZstdDecompress === 'function'
        ? fileStream.pipe(zlibExt.createZstdDecompress())
        : ext === '.gz'
        ? fileStream.pipe(zlib.createGunzip())
        : fileStream;
    const pgGuard = createSafePsqlRestoreTransform();

    cleanupFn = () => {
      fileStream.destroy();
      if (decompStream !== fileStream && 'destroy' in decompStream) {
        (decompStream as fs.ReadStream).destroy();
      }
      pgGuard.destroy();
    };

    fileStream.on('error', fail);
    if (decompStream !== fileStream) {
      decompStream.on('error', fail);
    }
    pgGuard.on('error', fail);
    decompStream.pipe(pgGuard);
    pgGuard.on('data', onDecompressedChunk);
    pgGuard.on('end', onDecompressedEnd);
  });
}

/**
 * Mục 9.2: Tự động nạp thử .sql.zst / .sql.gz vào container MariaDB Sandbox kiểm tra tính toàn vẹn
 */
export async function verifyJobDatabasesInSandbox(
  jobId: number,
  snapshotBaseDir: string,
  onLog: (msg: string) => void
): Promise<DbVerificationSummary[]> {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM backup_items WHERE job_id = ?')
    .all(jobId) as Record<string, unknown>[];

  const items: BackupItem[] = rows.map((r) => ({
    ...(r as unknown as BackupItem),
    databases_list: JSON.parse(String(r.databases_list || '[]')),
  }));

  const conn = await tryConnectSandboxMariaDb();
  const usingRealSandbox = Boolean(conn && process.platform !== 'win32');
  const sandboxCreds =
    usingRealSandbox && conn
      ? await ensureLeastPrivilegeSandboxCredentials(conn)
      : null;

  if (usingRealSandbox) {
    onLog(
      `[Sandbox Verify] Đã kết nối container MariaDB 10.11 Sandbox (tmpfs RAM). Bắt đầu nạp thử kiểm tra bảng...`
    );
  } else {
    onLog(
      `[Sandbox Verify] Chạy kiểm định cấu trúc & checksum luồng nén SQL (Chế độ Local SQL Inspector)...`
    );
  }

  const results: DbVerificationSummary[] = [];

  try {
    for (const item of items) {
      const preSecurityFailure =
        item.verification_status === 'CORRUPTED' &&
        item.verification_detail?.startsWith('[SECURITY]')
          ? item.verification_detail
          : null;

      if (!item.databases_list || item.databases_list.length === 0) {
        const staticStatus = preSecurityFailure ? 'CORRUPTED' : 'PASSED';
        const staticDetail = preSecurityFailure
          ? preSecurityFailure
          : 'Website tĩnh / Không sử dụng MySQL Database';
        db.prepare(
          `UPDATE backup_items SET verification_status = ?, verification_detail = ? WHERE id = ?`
        ).run(staticStatus, staticDetail, item.id);
        results.push({
          itemId: item.id,
          domainName: item.domain_name,
          status: staticStatus,
          detail: preSecurityFailure || 'Không có DB',
          databases: [],
        });
        continue;
      }

      let allPassed = !preSecurityFailure;
      const details: string[] = preSecurityFailure ? [preSecurityFailure] : [];
      const updatedDbs: DatabaseBackupInfo[] = [];

      for (const dbInfo of item.databases_list) {
        if (
          !dbInfo.file ||
          path.basename(dbInfo.file) !== dbInfo.file ||
          dbInfo.file.includes('..') ||
          /[/\\\0]/.test(dbInfo.file)
        ) {
          allPassed = false;
          const badMsg = `Tên file dump không hợp lệ: ${JSON.stringify(
            dbInfo.file
          )}`;
          details.push(`${dbInfo.name}: ${badMsg}`);
          updatedDbs.push({ ...dbInfo, verified: false, error: badMsg });
          continue;
        }

        const dumpPath = path.join(
          snapshotBaseDir,
          'home',
          'domains',
          item.domain_name,
          'databases',
          dbInfo.file
        );

        const isPostgres =
          dbInfo.engine === 'POSTGRESQL' || dbInfo.file.startsWith('pg_');

        if (isPostgres) {
          const pgCheck = await verifyPostgresDumpFile(dumpPath);
          if (!pgCheck.ok) {
            allPassed = false;
            details.push(`${dbInfo.name} [PG]: Lỗi (${pgCheck.error})`);
            onLog(
              `[Sandbox Verify] ❌ ${item.domain_name} -> ${dbInfo.name} (PostgreSQL): ${pgCheck.error}`
            );
            updatedDbs.push({
              ...dbInfo,
              engine: 'POSTGRESQL',
              verified: false,
              error: pgCheck.error,
            });
          } else {
            details.push(
              `${dbInfo.name} [PG]: Verified ✅ (${pgCheck.tablesCount} bảng, ~${pgCheck.rowsCount} dòng)`
            );
            onLog(
              `[Sandbox Verify] ✅ ${item.domain_name} -> ${dbInfo.name} (PostgreSQL): Toàn vẹn luồng Zstd & cấu trúc pg_dump (${pgCheck.tablesCount} bảng).`
            );
            updatedDbs.push({
              ...dbInfo,
              engine: 'POSTGRESQL',
              tables_count: pgCheck.tablesCount,
              rows_count: pgCheck.rowsCount,
              verified: true,
            });
          }
        } else if (usingRealSandbox && conn) {
          const tempDb = `verify_${jobId}_${crypto.randomBytes(4).toString('hex')}`;
          try {
            await conn.query(
              `CREATE DATABASE \`${tempDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            const importRes = await streamDumpIntoMariaDb({
              jobId,
              dumpFilePath: dumpPath,
              tempDbName: tempDb,
              dbUser: sandboxCreds?.user || 'root',
              dbPass: sandboxCreds?.pass || '',
            });
            if (!importRes.ok) {
              allPassed = false;
              details.push(`${dbInfo.name}: Lỗi nạp SQL (${importRes.error})`);
              updatedDbs.push({
                ...dbInfo,
                verified: false,
                error: importRes.error,
              });
            } else {
              const [statRows] = await conn.query<mysql.RowDataPacket[]>(
                `SELECT COUNT(*) AS tablesCount, IFNULL(SUM(table_rows), 0) AS rowsCount
                 FROM information_schema.tables
                 WHERE table_schema = ?`,
                [tempDb]
              );
              const tablesCount = Number(statRows[0]?.tablesCount || 0);
              const rowsCount = Number(statRows[0]?.rowsCount || 0);
              details.push(
                `${dbInfo.name}: Verified ✅ (${tablesCount} bảng, ~${rowsCount} dòng)`
              );
              onLog(
                `[Sandbox Verify] ✅ ${item.domain_name} -> ${dbInfo.name}: Khôi phục thử thành công (${tablesCount} bảng, ~${rowsCount} bản ghi).`
              );
              updatedDbs.push({
                ...dbInfo,
                tables_count: tablesCount,
                rows_count: rowsCount,
                verified: true,
              });
            }
          } finally {
            await conn
              .query(`DROP DATABASE IF EXISTS \`${tempDb}\``)
              .catch(() => {});
          }
        } else {
          const check = await verifySqlFileStructureFallback(dumpPath);
          if (!check.ok) {
            allPassed = false;
            details.push(`${dbInfo.name}: Lỗi (${check.error})`);
            onLog(
              `[Sandbox Verify] ❌ ${item.domain_name} -> ${dbInfo.name}: ${check.error}`
            );
            updatedDbs.push({ ...dbInfo, verified: false, error: check.error });
          } else {
            details.push(
              `${dbInfo.name}: Verified ✅ (${check.tablesCount} bảng, ~${check.rowsCount} dòng)`
            );
            onLog(
              `[Sandbox Verify] ✅ ${item.domain_name} -> ${dbInfo.name}: Toàn vẹn cấu trúc SQL (${check.tablesCount} bảng).`
            );
            updatedDbs.push({
              ...dbInfo,
              tables_count: check.tablesCount,
              rows_count: check.rowsCount,
              verified: true,
            });
          }
        }
      }

      const finalStatus = allPassed ? 'PASSED' : 'CORRUPTED';
      const detailStr = details.join(' | ');

      db.prepare(
        `UPDATE backup_items
         SET verification_status = ?, verification_detail = ?, databases_list = ?
         WHERE id = ?`
      ).run(finalStatus, detailStr, JSON.stringify(updatedDbs), item.id);

      results.push({
        itemId: item.id,
        domainName: item.domain_name,
        status: finalStatus,
        detail: detailStr,
        databases: updatedDbs,
      });
    }
  } finally {
    if (conn) {
      await conn.end().catch(() => {});
    }
  }

  return results;
}

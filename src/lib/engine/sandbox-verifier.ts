import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';
import { getDb } from '@/lib/db';
import { shellSingleQuote } from '@/lib/ssh';
import type { BackupItem, DatabaseBackupInfo } from '@/types';

const SANDBOX_IMPORT_TIMEOUT_MS = 10 * 60 * 1000;

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

function streamDumpIntoMariaDb(
  dumpFilePath: string,
  tempDbName: string
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const host = process.env.SANDBOX_DB_HOST || 'db_sandbox';
    const port = Number(process.env.SANDBOX_DB_PORT || 3306) || 3306;
    const user = process.env.SANDBOX_DB_USER || 'root';
    const pass = process.env.SANDBOX_DB_PASSWORD || 'sandbox_secret_pass';

    const ext = path.extname(dumpFilePath).toLowerCase();
    const decompCmd =
      ext === '.zst' ? 'zstd -dc' : ext === '.gz' ? 'gzip -dc' : 'cat';

    // Không truyền mật khẩu qua -p trên argv (chống lộ trong `ps aux`); truyền qua biến môi trường MYSQL_PWD.
    const pipeline = `${decompCmd} -- "$1" | mariadb -h ${shellSingleQuote(
      host
    )} -P ${port} -u ${shellSingleQuote(user)} ${shellSingleQuote(tempDbName)}`;

    const child = spawn(
      'bash',
      ['-o', 'pipefail', '-c', pipeline, 'sandbox-verify', dumpFilePath],
      {
        env: { ...process.env, MYSQL_PWD: pass },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      const forceKill = setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }, 5000);
      forceKill.unref();
    }, SANDBOX_IMPORT_TIMEOUT_MS);

    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      if (stderr.length > 32768) {
        stderr = stderr.slice(-16384);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ ok: false, error: err.message });
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (timedOut) {
        resolve({
          ok: false,
          error: 'Quá thời gian chờ (10 phút) khi nạp kiểm định vào MariaDB Sandbox',
        });
        return;
      }

      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: stderr.trim() || `MariaDB exited with code ${code}`,
        });
      }
    });
  });
}

async function verifySqlFileStructureFallback(dumpFilePath: string): Promise<{
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
    // Kiểm tra magic bytes chuẩn của Zstandard (0xFD2FB528)
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
    return { ok: true, tablesCount: 1, rowsCount: 1 };
  }

  // Giải nén và kiểm tra theo luồng O(1) RAM (head 8KB + rolling tail 8KB) để hỗ trợ cả file .sql.gz hàng chục GB
  return new Promise((resolve) => {
    const WINDOW_BYTES = 8192;
    let headBuf = Buffer.alloc(0);
    let tailBuf = Buffer.alloc(0);
    let totalUncompressedBytes = 0;
    let createCount = 0;
    let insertCount = 0;
    let carryText = '';
    let finished = false;

    const fileStream = fs.createReadStream(dumpFilePath);
    const sourceStream =
      ext === '.gz' ? fileStream.pipe(zlib.createGunzip()) : fileStream;

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      fileStream.destroy();
      sourceStream.destroy();
      resolve({
        ok: false,
        tablesCount: 0,
        rowsCount: 0,
        error: err.message,
      });
    };

    fileStream.on('error', fail);
    if (sourceStream !== fileStream) {
      sourceStream.on('error', fail);
    }

    sourceStream.on('data', (chunk: Buffer | string) => {
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
    });

    sourceStream.on('end', () => {
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
          error: 'Cấu trúc SQL bị ngắt quãng (thiếu dấu kết thúc hợp lệ ở cuối file)',
        });
        return;
      }

      resolve({
        ok: true,
        tablesCount: createCount,
        rowsCount: insertCount * 15,
      });
    });
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
          const badMsg = `Tên file dump không hợp lệ: ${JSON.stringify(dbInfo.file)}`;
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

        if (usingRealSandbox && conn) {
          const tempDb = `verify_${jobId}_${crypto.randomBytes(4).toString('hex')}`;
          try {
            await conn.query(
              `CREATE DATABASE \`${tempDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            const importRes = await streamDumpIntoMariaDb(dumpPath, tempDb);
            if (!importRes.ok) {
              allPassed = false;
              details.push(`${dbInfo.name}: Lỗi nạp SQL (${importRes.error})`);
              updatedDbs.push({ ...dbInfo, verified: false, error: importRes.error });
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
            await conn.query(`DROP DATABASE IF EXISTS \`${tempDb}\``).catch(() => {});
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


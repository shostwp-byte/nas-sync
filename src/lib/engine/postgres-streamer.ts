import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildSshBaseArgs, execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type { ServerRecord } from '@/types';
import { assertSafe, isSafeDbName, isSafeSystemUser } from './safe-names';
import { createSafePsqlRestoreTransform } from './sql-stream-guard';
import {
  DETACHED_PROCESS_GROUP,
  RetryableNetworkError,
  STREAM_IDLE_TIMEOUT_MS,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

type Node24ZlibWithZstd = typeof zlib & {
  createZstdDecompress?: () => NodeJS.ReadWriteStream;
};

export type PostgresDumpFormat = 'CUSTOM' | 'PLAIN_SQL';

const RESTORE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const PGDMP_MAGIC = Buffer.from('PGDMP', 'ascii');

/**
 * Nhận diện tự động định dạng tệp sao lưu PostgreSQL bằng 5 byte đầu sau giải nén (`PGDMP` = Custom Archive của `pg_dump -Fc`).
 */
export async function detectPostgresDumpFormat(
  dumpFilePath: string
): Promise<PostgresDumpFormat> {
  const ext = path.extname(dumpFilePath).toLowerCase();
  const zlibExt = zlib as Node24ZlibWithZstd;

  return new Promise((resolve, reject) => {
    let settled = false;
    let head = Buffer.alloc(0);
    let fallbackChild: ChildProcess | null = null;
    const rawStream = fs.createReadStream(dumpFilePath, { end: 65535 });

    const done = (fmt?: PostgresDumpFormat, err?: Error) => {
      if (settled) return;
      settled = true;
      rawStream.destroy();
      if (fallbackChild) {
        terminateChildGracefully(fallbackChild);
      }
      if (err) reject(err);
      else resolve(fmt || 'PLAIN_SQL');
    };

    const onChunk = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      head = Buffer.concat([head, buf]);
      if (head.length >= 5) {
        const isCustom = head.subarray(0, 5).equals(PGDMP_MAGIC);
        done(isCustom ? 'CUSTOM' : 'PLAIN_SQL');
      }
    };

    if (ext === '.zst') {
      if (typeof zlibExt.createZstdDecompress === 'function') {
        const zst = zlibExt.createZstdDecompress();
        rawStream.on('error', (e) => done(undefined, e));
        zst.on('error', (e: Error) => done(undefined, e));
        zst.on('data', onChunk);
        zst.on('end', () =>
          done(head.subarray(0, 5).equals(PGDMP_MAGIC) ? 'CUSTOM' : 'PLAIN_SQL')
        );
        rawStream.pipe(zst);
        return;
      }

      rawStream.destroy();
      fallbackChild = spawn('zstd', ['-dc', '--', dumpFilePath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: DETACHED_PROCESS_GROUP,
      });
      fallbackChild.stdout?.on('data', onChunk);
      fallbackChild.on('error', (e) => done(undefined, e));
      fallbackChild.on('close', () =>
        done(head.subarray(0, 5).equals(PGDMP_MAGIC) ? 'CUSTOM' : 'PLAIN_SQL')
      );
      return;
    }

    if (ext === '.gz') {
      const gz = zlib.createGunzip();
      rawStream.on('error', (e) => done(undefined, e));
      gz.on('error', (e) => done(undefined, e));
      gz.on('data', onChunk);
      gz.on('end', () =>
        done(head.subarray(0, 5).equals(PGDMP_MAGIC) ? 'CUSTOM' : 'PLAIN_SQL')
      );
      rawStream.pipe(gz);
      return;
    }

    rawStream.on('error', (e) => done(undefined, e));
    rawStream.on('data', onChunk);
    rawStream.on('end', () =>
      done(head.subarray(0, 5).equals(PGDMP_MAGIC) ? 'CUSTOM' : 'PLAIN_SQL')
    );
  });
}

/**
 * S12 & S6 Fix: Kiểm tra điều kiện tiên quyết bắt buộc (Fail-Closed) trước khi nạp bản sao lưu PostgreSQL:
 * 1. Kết nối nạp bắt buộc xác thực trực tiếp dưới role không phải superuser (`TCP_EPHEMERAL` hoặc `PEER_OS_USER`), không bao giờ dùng `postgres`.
 * 2. Nếu tệp sao lưu ở định dạng `PLAIN_SQL` cũ, `psql` trên VPS đích bắt buộc hỗ trợ `\restrict` gốc (CVE-2025-8714).
 */
export function assertPostgresRestoreSecurityCapabilities(params: {
  dumpFormat: PostgresDumpFormat;
  psqlSupportsRestrict: boolean;
  authMode: 'TCP_EPHEMERAL' | 'PEER_OS_USER' | 'NONE';
  pgRestoreAvailable: boolean;
}): void {
  if (params.authMode === 'NONE') {
    throw new Error(
      '[SECURITY] Từ chối khôi phục PostgreSQL: không thể thiết lập phiên xác thực trực tiếp bằng role không phải superuser trên VPS đích (hệ thống không bao giờ nạp dump dưới tài khoản superuser postgres).'
    );
  }

  if (params.dumpFormat === 'CUSTOM') {
    if (!params.pgRestoreAvailable) {
      throw new Error(
        'Máy chủ đích chưa cài đặt công cụ pg_restore (gói postgresql-client) để khôi phục định dạng sao lưu nhị phân PostgreSQL Custom Archive.'
      );
    }
    return;
  }

  if (!params.psqlSupportsRestrict) {
    throw new Error(
      '[SECURITY] Từ chối khôi phục tệp PostgreSQL dạng plain-SQL vì trình khách psql trên VPS đích chưa hỗ trợ \\restrict (CVE-2025-8714). Vui lòng nâng cấp postgresql-client trên VPS đích lên >= 17.6 / 16.10 / 15.14 / 14.19 / 13.22, hoặc tạo bản sao lưu mới ở định dạng pg_dump -Fc (.pgdump.zst).'
    );
  }
}

/**
 * Xây dựng lệnh thực thi từ xa chạy dưới tài khoản không phải superuser (tuyệt đối không chạy `su - postgres -c psql`).
 */
export function buildNonSuperuserPostgresRestoreRemoteCommand(params: {
  dumpFormat: PostgresDumpFormat;
  authMode: 'TCP_EPHEMERAL' | 'PEER_OS_USER';
  pgPort: number;
  safeTargetDb: string;
  ownerRole: string;
  ephemeralRole: string;
  ephemeralPass: string;
}): string {
  const {
    dumpFormat,
    authMode,
    pgPort,
    safeTargetDb,
    ownerRole,
    ephemeralRole,
    ephemeralPass,
  } = params;

  const safePort = Number.isInteger(pgPort) && pgPort > 0 && pgPort <= 65535 ? pgPort : 5432;

  if (authMode === 'TCP_EPHEMERAL') {
    const clientCmd =
      dumpFormat === 'CUSTOM'
        ? `pg_restore -h 127.0.0.1 -p ${safePort} -U ${shellSingleQuote(
            ephemeralRole
          )} --role=${shellSingleQuote(
            ownerRole
          )} --no-owner --no-privileges --clean --if-exists --exit-on-error -d ${shellSingleQuote(
            safeTargetDb
          )}`
        : `psql -X -h 127.0.0.1 -p ${safePort} -U ${shellSingleQuote(
            ephemeralRole
          )} -v ON_ERROR_STOP=1 -d ${shellSingleQuote(safeTargetDb)}`;

    const dropCleanup = shellSingleQuote(
      `psql -c 'REVOKE "${ownerRole}" FROM "${ephemeralRole}";' >/dev/null 2>&1 || true; psql -c 'DROP ROLE IF EXISTS "${ephemeralRole}";' >/dev/null 2>&1 || true`
    );

    return [
      'set -e',
      'umask 077',
      'TMP_PGPASS=$(mktemp /tmp/.nassync-pgpass.XXXXXX)',
      `cleanup() { rm -f "$TMP_PGPASS"; su - postgres -c ${dropCleanup} >/dev/null 2>&1 || true; }`,
      'trap cleanup EXIT INT TERM',
      `printf '127.0.0.1:%s:%s:%s:%s\\n' ${shellSingleQuote(
        String(safePort)
      )} ${shellSingleQuote(safeTargetDb)} ${shellSingleQuote(
        ephemeralRole
      )} ${shellSingleQuote(ephemeralPass)} > "$TMP_PGPASS"`,
      'chmod 600 "$TMP_PGPASS"',
      `PGPASSFILE="$TMP_PGPASS" ${clientCmd}`,
    ].join('\n');
  }

  // PEER_OS_USER: chạy trực tiếp dưới OS user không phải root/postgres qua Unix domain socket
  const peerClientInner =
    dumpFormat === 'CUSTOM'
      ? `pg_restore -p ${safePort} -U ${shellSingleQuote(
          ownerRole
        )} --role=${shellSingleQuote(
          ownerRole
        )} --no-owner --no-privileges --clean --if-exists --exit-on-error -d ${shellSingleQuote(
          safeTargetDb
        )}`
      : `psql -X -p ${safePort} -U ${shellSingleQuote(
          ownerRole
        )} -v ON_ERROR_STOP=1 -d ${shellSingleQuote(safeTargetDb)}`;

  const dropOnlyCleanup = shellSingleQuote(
    `psql -c 'DROP ROLE IF EXISTS "${ephemeralRole}";' >/dev/null 2>&1 || true`
  );

  return [
    'set -e',
    `cleanup() { su - postgres -c ${dropOnlyCleanup} >/dev/null 2>&1 || true; }`,
    'trap cleanup EXIT INT TERM',
    `if command -v runuser >/dev/null 2>&1; then runuser -u ${shellSingleQuote(
      ownerRole
    )} -- sh -c ${shellSingleQuote(
      peerClientInner
    )}; else su -s /bin/sh ${shellSingleQuote(
      ownerRole
    )} -c ${shellSingleQuote(peerClientInner)}; fi`,
  ].join('\n');
}

/**
 * Sao lưu PostgreSQL Database không dùng ổ cứng tạm trên VPS:
 * - Mặc định với tệp `.pgdump.zst`: dùng `pg_dump --format=custom --compress=0 --no-owner --no-privileges | zstd -3 -c`
 *   để khi khôi phục dùng `pg_restore` (loại bỏ hoàn toàn bề mặt meta-command `\` của `psql`, `S12`).
 * - Vẫn tương thích với `.sql.zst` nếu được yêu cầu tường minh.
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
  const useCustomFormat = fileName.toLowerCase().endsWith('.pgdump.zst');

  return new Promise((resolve, reject) => {
    let outStream: fs.WriteStream;
    let child: ChildProcess;
    try {
      const pgDumpCmd = useCustomFormat
        ? `pg_dump --format=custom --compress=0 --no-owner --no-privileges '${safeDb}'`
        : `pg_dump --no-owner --no-privileges --clean --if-exists '${safeDb}'`;
      const innerDumpScript = `if command -v ionice >/dev/null 2>&1 && ionice -c2 -n7 true 2>/dev/null; then IONICE_CMD="ionice -c2 -n7"; else IONICE_CMD=""; fi\n$IONICE_CMD nice -n19 su - postgres -c "${pgDumpCmd}" | zstd -3 -c`;
      const remoteDumpScript = `bash -o pipefail -c ${shellSingleQuote(innerDumpScript)}`;

      const sshArgs = [
        ...buildSshBaseArgs(server),
        '--',
        `${server.ssh_user || 'root'}@${server.ip_address}`,
        remoteDumpScript,
      ];

      outStream = fs.createWriteStream(tmpOutPath);
      child = spawn('ssh', sshArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: DETACHED_PROCESS_GROUP,
      });
      registerJobChildProcess(jobId, child);
    } catch (syncErr) {
      try {
        fs.rmSync(tmpOutPath, { force: true });
      } catch {
        // Ignore cleanup failure
      }
      reject(syncErr);
      return;
    }

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

    child.stdout?.on('data', () => {
      lastActivityAt = Date.now();
    });
    child.stdout?.pipe(outStream);
    child.stderr?.on('data', (d: Buffer) => {
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
            ).toFixed(1)} KB, định dạng ${
              useCustomFormat ? 'Custom Archive -Fc' : 'Plain SQL'
            }, không tốn ổ cứng tạm VPS).`
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
 * Khôi phục PostgreSQL Database qua SSH Pipe từ bản nén `.pgdump.zst` (`pg_restore`) hoặc `.sql.zst`/`.sql.gz` (`psql` có `\restrict`),
 * xác thực trực tiếp dưới role không phải superuser (`S6` & `S12`).
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
  const requestedUser = targetDbUser?.trim()
    ? assertSafe(
        isSafeSystemUser,
        targetDbUser.trim(),
        'Tên User PostgreSQL đích'
      )
    : '';

  const dumpFormat = await detectPostgresDumpFormat(dumpFilePath);
  const dbHash8 = crypto
    .createHash('sha256')
    .update(safeTargetDb)
    .digest('hex')
    .slice(0, 8);
  const fallbackOwnerRole = `nassync_own_${dbHash8}`;
  const ephemeralRole = `ns_rst_${crypto.randomBytes(6).toString('hex')}`;
  const ephemeralPass = crypto.randomBytes(24).toString('hex');

  const ensureScript = `
    set -e
    umask 077
    su - postgres -c ${shellSingleQuote(
      `psql -tc "SELECT 1 FROM pg_database WHERE datname = '${safeTargetDb}'" | grep -q 1 || createdb "${safeTargetDb}"`
    )}

    PG_PORT=$(su - postgres -c ${shellSingleQuote(
      'psql -Atc "SHOW port;"'
    )} 2>/dev/null | head -n1 | tr -d '[:space:]' || echo "5432")
    case "$PG_PORT" in
      ''|*[!0-9]*) PG_PORT=5432 ;;
    esac
    echo "PG_PORT=$PG_PORT"

    OWNER_ROLE=${shellSingleQuote(fallbackOwnerRole)}
    REQ_USER=${shellSingleQuote(requestedUser)}
    if [ -n "$REQ_USER" ] && [ "$REQ_USER" != "postgres" ] && [ "$REQ_USER" != "root" ]; then
      REQ_CHECK=$(su - postgres -c ${shellSingleQuote(
        `psql -Atc "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${requestedUser}') THEN 'MISSING' WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${requestedUser}' AND rolsuper = false AND NOT pg_has_role(rolname, 'pg_execute_server_program', 'MEMBER') AND NOT pg_has_role(rolname, 'pg_read_server_files', 'MEMBER') AND NOT pg_has_role(rolname, 'pg_write_server_files', 'MEMBER')) THEN 'SAFE' ELSE 'UNSAFE' END"`
      )} 2>/dev/null | head -n1 | tr -d '[:space:]' || true)
      if [ "$REQ_CHECK" = "MISSING" ]; then
        su - postgres -c ${shellSingleQuote(
          `psql -v ON_ERROR_STOP=1 -c 'CREATE ROLE "${requestedUser}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'`
        )}
        OWNER_ROLE="$REQ_USER"
      elif [ "$REQ_CHECK" = "SAFE" ]; then
        OWNER_ROLE="$REQ_USER"
      fi
    fi

    if [ "$OWNER_ROLE" = ${shellSingleQuote(fallbackOwnerRole)} ]; then
      su - postgres -c ${shellSingleQuote(
        `psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '${fallbackOwnerRole}'" | grep -q 1 || psql -v ON_ERROR_STOP=1 -c 'CREATE ROLE "${fallbackOwnerRole}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'`
      )}
    fi
    echo "PG_OWNER_ROLE=$OWNER_ROLE"

    su - postgres -c "psql -v ON_ERROR_STOP=1 -c 'GRANT ALL PRIVILEGES ON DATABASE \\"${safeTargetDb}\\" TO \\"$OWNER_ROLE\\"; ALTER DATABASE \\"${safeTargetDb}\\" OWNER TO \\"$OWNER_ROLE\\";'"
    su - postgres -c "psql -v ON_ERROR_STOP=1 -d '${safeTargetDb}' -c 'GRANT ALL ON SCHEMA public TO \\"$OWNER_ROLE\\"; ALTER SCHEMA public OWNER TO \\"$OWNER_ROLE\\";'"

    su - postgres -c ${shellSingleQuote(
      `psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS \\"${ephemeralRole}\\"; CREATE ROLE \\"${ephemeralRole}\\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT PASSWORD '${ephemeralPass}';"`
    )}
    su - postgres -c "psql -v ON_ERROR_STOP=1 -c 'GRANT \\"$OWNER_ROLE\\" TO \\"${ephemeralRole}\\";'"

    TMP_PROBE_PASS=$(mktemp /tmp/.nassync-probe.XXXXXX)
    printf '127.0.0.1:%s:%s:%s:%s\\n' "$PG_PORT" ${shellSingleQuote(
      safeTargetDb
    )} ${shellSingleQuote(ephemeralRole)} ${shellSingleQuote(
      ephemeralPass
    )} > "$TMP_PROBE_PASS"
    chmod 600 "$TMP_PROBE_PASS"
    if PGPASSFILE="$TMP_PROBE_PASS" psql -X -h 127.0.0.1 -p "$PG_PORT" -U ${shellSingleQuote(
      ephemeralRole
    )} -d ${shellSingleQuote(safeTargetDb)} -Atc "SELECT 1" >/dev/null 2>&1; then
      echo "PG_AUTH_MODE=TCP_EPHEMERAL"
    elif [ "$OWNER_ROLE" != "root" ] && [ "$OWNER_ROLE" != "postgres" ] && id -u "$OWNER_ROLE" >/dev/null 2>&1; then
      su - postgres -c "psql -v ON_ERROR_STOP=1 -c 'ALTER ROLE \\"$OWNER_ROLE\\" WITH LOGIN;'" >/dev/null 2>&1 || true
      if (command -v runuser >/dev/null 2>&1 && runuser -u "$OWNER_ROLE" -- psql -X -p "$PG_PORT" -U "$OWNER_ROLE" -d ${shellSingleQuote(
        safeTargetDb
      )} -Atc "SELECT 1" >/dev/null 2>&1) || su -s /bin/sh "$OWNER_ROLE" -c "psql -X -p $PG_PORT -U $OWNER_ROLE -d '${safeTargetDb}' -Atc 'SELECT 1'" >/dev/null 2>&1; then
        echo "PG_AUTH_MODE=PEER_OS_USER"
      fi
    fi
    rm -f "$TMP_PROBE_PASS"

    if command -v pg_restore >/dev/null 2>&1; then
      echo "PG_HAS_PGRESTORE=1"
    fi

    if printf '\\\\restrict nassyncprobe0001\\n\\\\unrestrict nassyncprobe0001\\n' | su - postgres -c ${shellSingleQuote(
      `psql -X -v ON_ERROR_STOP=1 -d '${safeTargetDb}'`
    )} >/dev/null 2>&1; then
      echo "PG_HAS_RESTRICT=1"
    fi
  `;

  const cleanupEphemeralRoleRemote = async () => {
    await execRemoteSSH(
      targetServer,
      `su - postgres -c ${shellSingleQuote(
        `psql -c 'DROP ROLE IF EXISTS "${ephemeralRole}";' >/dev/null 2>&1 || true`
      )}`,
      { zeroImpact: true, timeoutMs: 10000 }
    ).catch(() => {});
  };

  const ensureRes = await execRemoteSSH(targetServer, ensureScript, {
    zeroImpact: true,
    jobId,
  });
  if (ensureRes.code !== 0) {
    await cleanupEphemeralRoleRemote();
    throw new Error(
      `Không thể khởi tạo PostgreSQL database đích "${safeTargetDb}": ${ensureRes.stderr.trim()}`
    );
  }

  const portMatch = ensureRes.stdout.match(/^PG_PORT=(\d+)$/m);
  const pgPort = portMatch ? Number(portMatch[1]) : 5432;
  const ownerMatch = ensureRes.stdout.match(/^PG_OWNER_ROLE=([A-Za-z0-9_.-]+)$/m);
  const ownerRole = ownerMatch ? ownerMatch[1] : fallbackOwnerRole;
  const authMatch = ensureRes.stdout.match(
    /^PG_AUTH_MODE=(TCP_EPHEMERAL|PEER_OS_USER)$/m
  );
  const authMode: 'TCP_EPHEMERAL' | 'PEER_OS_USER' | 'NONE' = authMatch
    ? (authMatch[1] as 'TCP_EPHEMERAL' | 'PEER_OS_USER')
    : 'NONE';
  const pgRestoreAvailable = ensureRes.stdout.includes('PG_HAS_PGRESTORE=1');
  const psqlSupportsRestrict = ensureRes.stdout.includes('PG_HAS_RESTRICT=1');

  try {
    assertPostgresRestoreSecurityCapabilities({
      dumpFormat,
      psqlSupportsRestrict,
      authMode,
      pgRestoreAvailable,
    });
  } catch (capErr) {
    await cleanupEphemeralRoleRemote();
    throw capErr;
  }

  const confirmedAuthMode = authMode as 'TCP_EPHEMERAL' | 'PEER_OS_USER';
  const restrictKey = crypto.randomBytes(24).toString('hex');

  try {
    await new Promise<void>((resolve, reject) => {
      const ext = path.extname(dumpFilePath).toLowerCase();
      const zlibExt = zlib as Node24ZlibWithZstd;

      let sshChild: ChildProcess;
      try {
        const remoteRestoreCmd = buildNonSuperuserPostgresRestoreRemoteCommand({
          dumpFormat,
          authMode: confirmedAuthMode,
          pgPort,
          safeTargetDb,
          ownerRole,
          ephemeralRole,
          ephemeralPass,
        });

        sshChild = spawn(
          'ssh',
          [
            ...buildSshBaseArgs(targetServer),
            '--',
            `${targetServer.ssh_user || 'root'}@${targetServer.ip_address}`,
            remoteRestoreCmd,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: DETACHED_PROCESS_GROUP,
          }
        );
        registerJobChildProcess(jobId, sshChild);
      } catch (syncErr) {
        reject(syncErr);
        return;
      }

      let decompChild: ChildProcess | null = null;
      const fileStream = fs.createReadStream(dumpFilePath);
      let rawStream: NodeJS.ReadableStream;

      if (ext === '.zst') {
        if (typeof zlibExt.createZstdDecompress === 'function') {
          rawStream = fileStream.pipe(zlibExt.createZstdDecompress());
        } else {
          decompChild = spawn('zstd', ['-dc', '--', dumpFilePath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: DETACHED_PROCESS_GROUP,
          });
          fileStream.destroy();
          registerJobChildProcess(jobId, decompChild);
          rawStream = decompChild.stdout!;
        }
      } else if (ext === '.gz') {
        rawStream = fileStream.pipe(zlib.createGunzip());
      } else {
        rawStream = fileStream;
      }

      let stderr = '';
      let lastActivityAt = Date.now();
      let idleTimedOut = false;
      let settled = false;

      const sqlGuard =
        dumpFormat === 'PLAIN_SQL'
          ? createSafePsqlRestoreTransform({
              nonSuperuserRole: ownerRole,
              onBytesTransferred: () => {
                lastActivityAt = Date.now();
              },
            })
          : null;

      const abortAll = (err: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(watcher);
        fileStream.destroy();
        if ('destroy' in rawStream && typeof rawStream.destroy === 'function') {
          rawStream.destroy();
        }
        sqlGuard?.destroy();
        if (decompChild) {
          terminateChildGracefully(decompChild);
        }
        terminateChildGracefully(sshChild);
        reject(err);
      };

      const watcher = setInterval(() => {
        if (isJobCancelled(jobId)) {
          abortAll(new Error('Job khôi phục đã bị hủy bởi quản trị viên.'));
          return;
        }
        if (Date.now() - lastActivityAt > RESTORE_IDLE_TIMEOUT_MS) {
          idleTimedOut = true;
          abortAll(
            new Error(
              `Nạp PostgreSQL Database ${safeTargetDb} quá thời gian chờ 30 phút (Idle Timeout).`
            )
          );
        }
      }, 3000);

      fileStream.on('data', () => {
        lastActivityAt = Date.now();
      });
      fileStream.on('error', (err) => abortAll(err));
      if (rawStream !== fileStream) {
        rawStream.on('error', (err: Error) => abortAll(err));
      }
      if (decompChild) {
        let decompErr = '';
        decompChild.stderr?.on('data', (d: Buffer) => {
          decompErr += d.toString('utf8');
        });
        decompChild.on('error', (err) => abortAll(err));
        decompChild.on('close', (code) => {
          if (code !== 0 && !settled) {
            abortAll(
              new Error(
                `Giải nén tệp sao lưu PostgreSQL thất bại (code ${code}): ${decompErr.trim()}`
              )
            );
          }
        });
      }

      sshChild.stdin?.on('error', () => {
        // Bỏ qua EPIPE khi tiến trình từ xa đóng sớm; mã lỗi thực được bắt ở sự kiện 'close'
      });

      sshChild.stdout?.on('data', () => {
        lastActivityAt = Date.now();
      });
      sshChild.stderr?.on('data', (d: Buffer) => {
        lastActivityAt = Date.now();
        stderr += d.toString('utf8');
        if (stderr.length > 65536) {
          stderr = stderr.slice(-32768);
        }
      });
      sshChild.on('error', (err) => abortAll(err));

      if (dumpFormat === 'CUSTOM') {
        rawStream.on('data', () => {
          lastActivityAt = Date.now();
        });
        rawStream.pipe(sshChild.stdin!);
      } else {
        sqlGuard!.on('error', (err) => abortAll(err));
        // Bắt buộc khóa phiên bằng \restrict gốc của psql và đặt ROLE sở hữu đích
        const preludeLines = [
          `SET ROLE "${ownerRole}";`,
          `\\restrict ${restrictKey}`,
        ];
        sshChild.stdin!.write(`${preludeLines.join('\n')}\n`);
        rawStream.pipe(sqlGuard!);
        sqlGuard!.pipe(sshChild.stdin!, { end: false });
        sqlGuard!.on('end', () => {
          if (settled) return;
          sshChild.stdin!.write(`\n\\unrestrict ${restrictKey}\n`);
          sshChild.stdin!.end();
        });
      }

      sshChild.on('close', (code) => {
        if (settled) return;
        settled = true;
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
  } finally {
    await cleanupEphemeralRoleRemote();
  }
}

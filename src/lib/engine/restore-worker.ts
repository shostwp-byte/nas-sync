import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Transform } from 'node:stream';
import zlib from 'node:zlib';
import { getDataDir, getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress, emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  ensureServerHostKeyPinned,
  execRemoteSSH,
  shellSingleQuote,
} from '@/lib/ssh';
import type {
  BackupItem,
  BackupJob,
  DatabaseBackupInfo,
  DomainMetadataJson,
  MysqlAdminCredentials,
  RestoreRequestPayload,
  ServerRecord,
  StorageVolume,
} from '@/types';
import { getPanelAdapter } from './adapters';
import {
  buildJailedRsyncPath,
  buildMysqlAuthFlags,
  buildRemoteMysqlEnvPrelude,
  verifyRemoteWebrootSafety,
} from './adapters/base';
import {
  extractDbCredentialsFromDirectory,
  extractDbCredentialsFromRemoteWebrootOverSsh,
  patchRestoredWebConfigOverSsh,
  type ExtractedWebDbConfig,
} from './config-rewriter';
import { streamRestorePostgresOverSsh } from './postgres-streamer';
import {
  assertSafe,
  isSafeDbName,
  isSafeDomain,
  isSafeSnapshotName,
  isSafeSystemUser,
  isSafeWebroot,
} from './safe-names';
import { acquireSnapshotReadPin } from './snapshot-pins';
import {
  DETACHED_PROCESS_GROUP,
  clearCancelledJob,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

const RESTORE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const RESTORE_PERMISSION_FIX_TIMEOUT_MS = 15 * 60 * 1000;

export function buildRsyncRestoreArgs(params: {
  targetServer: ServerRecord;
  targetUser: string;
  localPublicHtmlDir: string;
  targetWebroot: string;
  excludedSubpaths?: string[];
}): string[] {
  const {
    targetServer,
    targetUser,
    localPublicHtmlDir,
    targetWebroot,
    excludedSubpaths,
  } = params;

  // S14 Security Fix: Loại bỏ quyền sở hữu gốc (--no-owner --no-group) và bit setuid/setgid (--chmod=ugo-s).
  // Lưu ý: `-a` mặc định đã tắt `-K` (--keep-dirlinks); không dùng `--no-keep-dirlinks` để tương thích rsync 3.4/3.5+.
  const args: string[] = [
    '-az',
    '--no-owner',
    '--no-group',
    '--chmod=ugo-s',
    '--delete',
    '--no-devices',
    '--no-specials',
    '--safe-links',
    '--info=progress2',
    '--timeout=60',
  ];
  if (excludedSubpaths && excludedSubpaths.length > 0) {
    for (const rel of excludedSubpaths) {
      const cleanRel = rel.replace(/^\/+|\/+$/g, '');
      if (cleanRel && !cleanRel.includes('..') && !/[\r\n\0]/.test(cleanRel)) {
        args.push(`--exclude=/${cleanRel}`);
      }
    }
  }
  if (targetServer.bw_limit_kbps && targetServer.bw_limit_kbps > 0) {
    args.push(`--bwlimit=${targetServer.bw_limit_kbps}`);
  }
  args.push('-e', buildRsyncSshTransport(targetServer));
  // S3 Security Fix: Ghim inode thư mục webroot đích bằng realpath + cd -P + pwd -P và ưu tiên hạ quyền xuống user của site
  args.push(
    `--rsync-path=${buildJailedRsyncPath(targetWebroot, {
      runAsUser: targetUser,
      mode: 'push',
    })}`
  );
  args.push(
    `${localPublicHtmlDir.replace(/\/+$/, '')}/`,
    `${targetServer.ssh_user || 'root'}@${targetServer.ip_address}:./`
  );
  return args;
}

function pushFilesViaRsync(params: {
  jobId: number;
  targetServer: ServerRecord;
  targetUser: string;
  localPublicHtmlDir: string;
  targetWebroot: string;
  excludedSubpaths?: string[];
  onProgress: (pct: number) => void;
}): Promise<void> {
  const { jobId, onProgress } = params;
  const args = buildRsyncRestoreArgs(params);

  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: DETACHED_PROCESS_GROUP,
    });
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

    child.stdout.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      const m = chunk.toString('utf8').match(/(\d+)%/);
      if (m) {
        onProgress(Math.min(100, Number(m[1])));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stderr += chunk.toString('utf8');
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
            'Rsync Restore bị treo quá 30 phút không có phản hồi dữ liệu.'
          )
        );
        return;
      }
      if (code === 0 || code === 24) resolve();
      else reject(new Error(`Rsync Restore lỗi (code ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * S13 Fix: Đặt `${authFlags}` (có thể chứa `--defaults-extra-file=...`) ĐỨNG ĐẦU TIÊN ngay sau `mysql`
 * trước `--binary-mode` để tương thích tuyệt đối với MySQL 8.x trên cPanel/HestiaCP/CyberPanel/CloudPanel.
 */
export function buildRemoteMysqlRestoreInnerCommand(
  creds: MysqlAdminCredentials,
  targetDbName: string
): string {
  const authFlags = buildMysqlAuthFlags(creds).trim();
  const envPrelude = buildRemoteMysqlEnvPrelude(creds);
  const safeDb = assertSafe(isSafeDbName, targetDbName, 'Tên database đích');
  const flagPart = authFlags ? `${authFlags} --binary-mode` : '--binary-mode';
  return `${envPrelude}mysql ${flagPart} ${shellSingleQuote(safeDb)}`;
}

const RESERVED_MYSQL_USERS = new Set([
  'root',
  'da_admin',
  'admin',
  'mysql',
  'mysql.sys',
  'mysql.session',
  'mysql.infoschema',
  'debian-sys-maint',
  'mariadb.sys',
  'phpmyadmin',
  'roundcube',
  'cphulkd',
  'postgres',
  'clp',
  'hestia',
]);

export function isProvisionableDbUser(user: string): boolean {
  const clean = (user || '').trim();
  if (!clean) return false;
  if (RESERVED_MYSQL_USERS.has(clean.toLowerCase())) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(clean);
}

/**
 * Xây dựng lệnh khởi tạo Database + MySQL User + Password (từ wp-config.php / .env) + GRANT ALL PRIVILEGES.
 * Sử dụng mã hóa Hex (`UNHEX(...)`) kết hợp `PREPARE`/`EXECUTE` và `QUOTE(...)` của MySQL/MariaDB
 * để xử lý an toàn 100% mọi ký tự đặc biệt trong mật khẩu mà không lộ plaintext hay lỗi thoát chuỗi shell/SQL.
 */
export function buildMysqlProvisionDatabaseAndUserScript(params: {
  creds: MysqlAdminCredentials;
  targetDbName: string;
  dbUser?: string;
  dbPassword?: string;
  dbHost?: string;
  panelType?: ServerRecord['panel_type'];
  targetSystemUser?: string;
}): {
  createDbCommand: string;
  provisionUserCommand: string | null;
  provisionedUser: string | null;
  hosts: string[];
} {
  const safeDb = assertSafe(isSafeDbName, params.targetDbName, 'Tên database đích');
  const authFlags = buildMysqlAuthFlags(params.creds).trim();
  const envPrelude = buildRemoteMysqlEnvPrelude(params.creds);

  const createDbSql = `CREATE DATABASE IF NOT EXISTS \`${safeDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
  const createDbInner = `${envPrelude}mysql ${authFlags ? `${authFlags} ` : ''}-e ${shellSingleQuote(createDbSql)}`;
  const createDbCommand = `bash -o pipefail -c ${shellSingleQuote(createDbInner)}`;

  const rawUser = (params.dbUser || '').trim();
  const canProvisionUser = isProvisionableDbUser(rawUser);

  const hosts = ['localhost', '127.0.0.1'];
  const customHost = (params.dbHost || '').trim().split(':')[0]?.trim() || '';
  if (
    customHost &&
    customHost !== 'localhost' &&
    customHost !== '127.0.0.1' &&
    /^(?:%|[a-zA-Z0-9._-]+)$/.test(customHost)
  ) {
    hosts.push(customHost);
  }

  const sqlLines: string[] = [];

  if (canProvisionUser) {
    const userHex = Buffer.from(rawUser, 'utf8').toString('hex');
    sqlLines.push(`SET @u = CONVERT(UNHEX('${userHex}') USING utf8mb4);`);

    if (params.dbPassword !== undefined) {
      const pwdHex = Buffer.from(params.dbPassword, 'utf8').toString('hex');
      sqlLines.push(`SET @p = CONVERT(UNHEX('${pwdHex}') USING utf8mb4);`);

      for (const h of hosts) {
        const hostHex = Buffer.from(h, 'utf8').toString('hex');
        sqlLines.push(
          `SET @h = CONVERT(UNHEX('${hostHex}') USING utf8mb4);`,
          `SET @s1 = CONCAT('CREATE USER IF NOT EXISTS ', QUOTE(@u), '@', QUOTE(@h), ' IDENTIFIED BY ', QUOTE(@p));`,
          `PREPARE stmt FROM @s1; EXECUTE stmt; DEALLOCATE PREPARE stmt;`,
          `SET @s2 = CONCAT('ALTER USER ', QUOTE(@u), '@', QUOTE(@h), ' IDENTIFIED BY ', QUOTE(@p));`,
          `PREPARE stmt FROM @s2; EXECUTE stmt; DEALLOCATE PREPARE stmt;`,
          `SET @s3 = CONCAT('GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO ', QUOTE(@u), '@', QUOTE(@h));`,
          `PREPARE stmt FROM @s3; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
        );
      }
    } else {
      for (const h of hosts) {
        const hostHex = Buffer.from(h, 'utf8').toString('hex');
        sqlLines.push(
          `SET @h = CONVERT(UNHEX('${hostHex}') USING utf8mb4);`,
          `SELECT COUNT(*) INTO @u_exists FROM mysql.user WHERE User = @u AND Host = @h;`,
          `SET @s3 = IF(@u_exists > 0, CONCAT('GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO ', QUOTE(@u), '@', QUOTE(@h)), 'DO 0');`,
          `PREPARE stmt FROM @s3; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
        );
      }
    }
  }

  if (params.panelType === 'DIRECTADMIN') {
    sqlLines.push(
      `SELECT COUNT(*) INTO @da_exists FROM mysql.user WHERE User = 'da_admin' AND Host = 'localhost';`,
      `SET @sda = IF(@da_exists > 0, 'GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO ''da_admin''@''localhost'' WITH GRANT OPTION', 'DO 0');`,
      `PREPARE stmt FROM @sda; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
    );
    const cleanSysUser = (params.targetSystemUser || '').trim();
    if (cleanSysUser && isSafeSystemUser(cleanSysUser)) {
      const sysUserHex = Buffer.from(cleanSysUser, 'utf8').toString('hex');
      sqlLines.push(
        `SET @su = CONVERT(UNHEX('${sysUserHex}') USING utf8mb4);`,
        `SELECT COUNT(*) INTO @su_exists FROM mysql.user WHERE User = @su AND Host = 'localhost';`,
        `SET @ssu = IF(@su_exists > 0, CONCAT('GRANT ALL PRIVILEGES ON \`${safeDb}\`.* TO ', QUOTE(@su), '@''localhost'''), 'DO 0');`,
        `PREPARE stmt FROM @ssu; EXECUTE stmt; DEALLOCATE PREPARE stmt;`
      );
    }
  }

  if (sqlLines.length === 0) {
    return {
      createDbCommand,
      provisionUserCommand: null,
      provisionedUser: null,
      hosts,
    };
  }

  sqlLines.push('FLUSH PRIVILEGES;');
  const flagPart = authFlags ? `${authFlags} --force` : '--force';
  const provisionInner = `${envPrelude}mysql ${flagPart} -e ${shellSingleQuote(sqlLines.join('\n'))}`;
  const provisionUserCommand = `bash -o pipefail -c ${shellSingleQuote(provisionInner)}`;

  return {
    createDbCommand,
    provisionUserCommand,
    provisionedUser: canProvisionUser ? rawUser : null,
    hosts,
  };
}

/**
 * Đăng ký ánh xạ Database & User vào metadata của Hosting Control Panel đích (cPanel, aaPanel, CyberPanel)
 * để quản trị viên thấy ngay Database/User trên giao diện Panel sau khi khôi phục.
 */
async function registerRestoredDatabaseInPanel(params: {
  targetServer: ServerRecord;
  creds: MysqlAdminCredentials;
  targetUser: string;
  targetDomain: string;
  targetDbName: string;
  dbUser: string;
  dbPassword?: string;
  jobId: number;
  onLog: (msg: string) => void;
}): Promise<void> {
  const {
    targetServer,
    creds,
    targetUser,
    targetDomain,
    targetDbName,
    dbUser,
    dbPassword,
    jobId,
    onLog,
  } = params;

  if (targetServer.is_mock) return;
  const safeDb = assertSafe(isSafeDbName, targetDbName, 'targetDbName');
  const effectiveDbUser = isProvisionableDbUser(dbUser) ? dbUser.trim() : targetUser;

  try {
    if (targetServer.panel_type === 'CPANEL' && isSafeSystemUser(targetUser)) {
      const cmd = [
        'if [ -x /usr/local/cpanel/bin/dbmaptool ]; then',
        `  /usr/local/cpanel/bin/dbmaptool ${shellSingleQuote(targetUser)} --type mysql --dbs ${shellSingleQuote(safeDb)} --dbusers ${shellSingleQuote(effectiveDbUser)} >/dev/null 2>&1 || true`,
        'fi',
        'if command -v uapi >/dev/null 2>&1; then',
        `  uapi --user=${shellSingleQuote(targetUser)} Mysql set_privileges_on_database user=${shellSingleQuote(effectiveDbUser)} database=${shellSingleQuote(safeDb)} privileges='ALL PRIVILEGES' >/dev/null 2>&1 || true`,
        'fi',
      ].join('\n');
      await execRemoteSSH(targetServer, cmd, {
        zeroImpact: true,
        timeoutMs: 20000,
        jobId,
      });
      onLog(
        `[Panel Mapping] Đã ánh xạ Database "${safeDb}" & User "${effectiveDbUser}" vào tài khoản cPanel "${targetUser}".`
      );
    } else if (targetServer.panel_type === 'AAPANEL' && isSafeDomain(targetDomain)) {
      const pyScript = `
import sqlite3, time
conn = sqlite3.connect('/www/server/panel/data/default.db')
cur = conn.cursor()
cur.execute("SELECT id FROM sites WHERE name=? LIMIT 1", (${JSON.stringify(targetDomain)},))
srow = cur.fetchone()
pid = int(srow[0]) if srow and srow[0] else 0
cur.execute("SELECT id, password FROM databases WHERE name=? LIMIT 1", (${JSON.stringify(safeDb)},))
drow = cur.fetchone()
pwd = ${JSON.stringify(dbPassword ?? '')}
if drow:
    if pwd:
        cur.execute("UPDATE databases SET username=?, password=?, pid=CASE WHEN ? > 0 THEN ? ELSE pid END WHERE id=?", (${JSON.stringify(effectiveDbUser)}, pwd, pid, pid, drow[0]))
    else:
        cur.execute("UPDATE databases SET username=?, pid=CASE WHEN ? > 0 THEN ? ELSE pid END WHERE id=?", (${JSON.stringify(effectiveDbUser)}, pid, pid, drow[0]))
else:
    now_str = time.strftime('%Y-%m-%d %H:%M:%S')
    try:
        cur.execute("INSERT INTO databases (pid, name, username, password, accept, ps, addtime, type) VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, 'MySQL')", (pid, ${JSON.stringify(safeDb)}, ${JSON.stringify(effectiveDbUser)}, pwd, ${JSON.stringify(targetDomain)}, now_str))
    except Exception:
        cur.execute("INSERT INTO databases (pid, name, username, password, accept, ps, addtime) VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?)", (pid, ${JSON.stringify(safeDb)}, ${JSON.stringify(effectiveDbUser)}, pwd, ${JSON.stringify(targetDomain)}, now_str))
conn.commit()
`;
      const cmd = `
        PY="/www/server/panel/pyenv/bin/python3"
        [ ! -x "$PY" ] && PY="python3"
        "$PY" -c ${shellSingleQuote(pyScript)} >/dev/null 2>&1 || true
      `;
      await execRemoteSSH(targetServer, cmd, {
        zeroImpact: true,
        timeoutMs: 20000,
        jobId,
      });
      onLog(
        `[Panel Mapping] Đã đăng ký Database "${safeDb}" & User "${effectiveDbUser}" vào danh mục quản lý aaPanel.`
      );
    } else if (targetServer.panel_type === 'CYBERPANEL' && isSafeDomain(targetDomain)) {
      const authFlags = buildMysqlAuthFlags(creds).trim();
      const envPrelude = buildRemoteMysqlEnvPrelude(creds);
      const userHex = Buffer.from(effectiveDbUser, 'utf8').toString('hex');
      const domHex = Buffer.from(targetDomain, 'utf8').toString('hex');
      const sql = [
        `SET @u = CONVERT(UNHEX('${userHex}') USING utf8mb4);`,
        `SET @d = CONVERT(UNHEX('${domHex}') USING utf8mb4);`,
        `INSERT INTO cyberpanel.databases_databases (website_id, dbName, dbUser)`,
        `SELECT w.id, '${safeDb}', @u FROM cyberpanel.websiteFunctions_websites w`,
        `WHERE w.domain = @d AND NOT EXISTS (SELECT 1 FROM cyberpanel.databases_databases x WHERE x.dbName = '${safeDb}') LIMIT 1;`,
      ].join(' ');
      const inner = `${envPrelude}mysql ${authFlags ? `${authFlags} ` : ''}--force -e ${shellSingleQuote(sql)} >/dev/null 2>&1 || true`;
      await execRemoteSSH(targetServer, `bash -c ${shellSingleQuote(inner)}`, {
        zeroImpact: true,
        timeoutMs: 15000,
        jobId,
      });
      onLog(
        `[Panel Mapping] Đã đăng ký Database "${safeDb}" & User "${effectiveDbUser}" vào danh mục quản lý CyberPanel.`
      );
    }
  } catch {
    // Non-fatal: MySQL database và quyền truy cập đã được cấp thành công ở tầng hệ quản trị CSDL
  }
}

function streamRestoreDatabaseOverSsh(params: {
  jobId: number;
  targetServer: ServerRecord;
  creds: MysqlAdminCredentials;
  dumpFilePath: string;
  targetDbName: string;
}): Promise<void> {
  const { jobId, targetServer, creds, dumpFilePath, targetDbName } = params;

  return new Promise((resolve, reject) => {
    let sshChild: ChildProcessWithoutNullStreams;
    const ext = path.extname(dumpFilePath).toLowerCase();
    try {
      // S1 & S13 Security Fix: --defaults-extra-file đứng đầu, --binary-mode vô hiệu hóa meta-command `\! <shell>` của MySQL client
      const remoteInner = buildRemoteMysqlRestoreInnerCommand(
        creds,
        targetDbName
      );
      const remoteMysqlCmd = `bash -o pipefail -c ${shellSingleQuote(remoteInner)}`;

      // N2 & N5 Fix: Không dùng `bash -c "... | ssh"`, nối trực tiếp stream giải nén trong Node sang ssh.stdin
      // và ghi nhận từng khối byte đọc từ file dump là hoạt động sống (tránh Idle Timeout giả khi import > 30 phút)
      sshChild = spawn(
        'ssh',
        [
          ...buildSshBaseArgs(targetServer),
          '--',
          `${targetServer.ssh_user || 'root'}@${targetServer.ip_address}`,
          remoteMysqlCmd,
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: DETACHED_PROCESS_GROUP,
        }
      );
      registerJobChildProcess(jobId, sshChild);
    } catch (syncErr) {
      reject(syncErr);
      return;
    }

    const zlibWithZstd = zlib as typeof zlib & {
      createZstdDecompress?: () => Transform;
    };

    let sourceStream: Readable | null = null;
    let zstdFallbackChild: ReturnType<typeof spawn> | null = null;
    let decompError: Error | null = null;
    let stderr = '';
    let lastActivityAt = Date.now();
    let idleTimedOut = false;
    let settled = false;

    const cleanupStreams = () => {
      try {
        sourceStream?.destroy();
      } catch {
        // Ignore
      }
      if (zstdFallbackChild) {
        terminateChildGracefully(zstdFallbackChild);
      }
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(watcher);
      cleanupStreams();
      if (err) reject(err);
      else resolve();
    };

    const watcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        cleanupStreams();
        terminateChildGracefully(sshChild);
        return;
      }
      if (Date.now() - lastActivityAt > RESTORE_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        cleanupStreams();
        terminateChildGracefully(sshChild);
      }
    }, 3000);

    try {
      if (ext === '.zst' && typeof zlibWithZstd.createZstdDecompress !== 'function') {
        zstdFallbackChild = spawn('zstd', ['-dc', '--', dumpFilePath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: DETACHED_PROCESS_GROUP,
        });
        registerJobChildProcess(jobId, zstdFallbackChild);
        zstdFallbackChild.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        zstdFallbackChild.on('error', (err) => {
          decompError = err;
          terminateChildGracefully(sshChild);
        });
        zstdFallbackChild.on('close', (zCode) => {
          if (zCode !== 0 && !isJobCancelled(jobId) && !idleTimedOut) {
            decompError = new Error(`Giải nén zstd thất bại (code ${zCode}).`);
            terminateChildGracefully(sshChild);
          }
        });
        sourceStream = zstdFallbackChild.stdout!;
      } else {
        const rawRead = fs.createReadStream(dumpFilePath);
        rawRead.on('data', () => {
          lastActivityAt = Date.now();
        });
        rawRead.on('error', (err) => {
          decompError = err;
          terminateChildGracefully(sshChild);
        });

        if (ext === '.zst') {
          const zst = zlibWithZstd.createZstdDecompress!();
          zst.on('error', (err) => {
            decompError = err;
            rawRead.destroy();
            terminateChildGracefully(sshChild);
          });
          rawRead.pipe(zst);
          sourceStream = zst;
        } else if (ext === '.gz') {
          const gunzip = zlib.createGunzip();
          gunzip.on('error', (err) => {
            decompError = err;
            rawRead.destroy();
            terminateChildGracefully(sshChild);
          });
          rawRead.pipe(gunzip);
          sourceStream = gunzip;
        } else {
          sourceStream = rawRead;
        }
      }

      sourceStream.on('data', () => {
        lastActivityAt = Date.now();
      });
      sshChild.stdin.on('error', () => {
        // Sẽ được xử lý ở sự kiện close/error của sshChild
      });
      sourceStream.pipe(sshChild.stdin);
    } catch (initErr) {
      terminateChildGracefully(sshChild);
      finish(initErr as Error);
      return;
    }

    sshChild.stdout.on('data', () => {
      lastActivityAt = Date.now();
    });
    sshChild.stderr.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      stderr += d.toString('utf8');
      if (stderr.length > 65536) {
        stderr = stderr.slice(-32768);
      }
    });
    sshChild.on('error', (err) => {
      finish(err);
    });
    sshChild.on('close', (code) => {
      if (isJobCancelled(jobId)) {
        finish(new Error('Job khôi phục đã bị hủy bởi quản trị viên.'));
        return;
      }
      if (idleTimedOut) {
        finish(
          new Error(
            `Nạp Database ${targetDbName} quá thời gian chờ 30 phút (Idle Timeout).`
          )
        );
        return;
      }
      if (decompError) {
        finish(
          new Error(
            `Lỗi đọc/giải nén tệp SQL cho "${targetDbName}": ${decompError.message}`
          )
        );
        return;
      }
      if (code === 0) finish();
      else
        finish(
          new Error(
            `Nạp Database ${targetDbName} thất bại (code ${code}): ${stderr.trim()}`
          )
        );
    });
  });
}

/**
 * Mục 8: Cơ chế Khôi phục Đa năng (Files Only / DB Only / Cross-Panel Migration + SSH TOFU Pinning)
 */
export async function executeRestoreJob(jobId: number): Promise<void> {
  const db = getDb();
  let job: BackupJob | undefined;
  let payload: RestoreRequestPayload;
  let item: BackupItem;
  let sourceServer: ServerRecord;
  let targetServer: ServerRecord;
  let sourceVolume: StorageVolume;

  // N22 Fix: Bọc toàn bộ bước kiểm tra đầu vào bên trong try/catch để mọi lỗi cấu hình/dữ liệu mồ côi
  // đều chuyển Job sang FAILED kèm cảnh báo thay vì kẹt vĩnh viễn ở RUNNING.
  try {
    job = db
      .prepare('SELECT * FROM backup_jobs WHERE id = ?')
      .get(jobId) as unknown as BackupJob | undefined;
    if (!job || !job.restore_options) {
      throw new Error(`Không tìm thấy thông tin cấu hình Restore cho Job #${jobId}`);
    }

    payload = JSON.parse(job.restore_options) as RestoreRequestPayload;

    const itemRow = db
      .prepare('SELECT * FROM backup_items WHERE id = ?')
      .get(payload.backupItemId) as Record<string, unknown> | undefined;
    if (!itemRow) {
      throw new Error(`Không tìm thấy bản sao lưu domain #${payload.backupItemId}`);
    }

    item = {
      ...(itemRow as unknown as BackupItem),
      databases_list: JSON.parse(String(itemRow.databases_list || '[]')),
    };

    sourceServer = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(item.server_id) as unknown as ServerRecord;
    targetServer = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(payload.targetServerId) as unknown as ServerRecord;
    sourceVolume = db
      .prepare('SELECT * FROM storage_volumes WHERE id = ?')
      .get(item.volume_id) as unknown as StorageVolume;

    if (!sourceServer || !targetServer || !sourceVolume) {
      throw new Error('Thiếu thông tin máy chủ nguồn, máy chủ đích hoặc Volume lưu trữ.');
    }
  } catch (preErr) {
    const errMsg = (preErr as Error).message || 'Dữ liệu đầu vào khôi phục không hợp lệ.';
    const cancelled = isJobCancelled(jobId);
    const terminalStatus = cancelled ? 'CANCELLED' : 'FAILED';
    const terminalPhase = cancelled
      ? 'Đã hủy bởi quản trị viên'
      : 'Khôi phục thất bại (Dữ liệu đầu vào)';
    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, current_phase = ?, completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(terminalStatus, terminalPhase, errMsg, jobId);
    emitJobProgress({
      jobId,
      serverId: Number(job?.target_server_id || job?.server_id || 0),
      hostname: '',
      status: terminalStatus,
      progressPercent: Number(job?.progress_percent || 0),
      currentPhase: terminalPhase,
      currentDomain: String(job?.current_domain || ''),
      speedBps: 0,
      etaSeconds: 0,
      deltaSizeBytes: 0,
      totalSizeBytes: Number(job?.total_size_bytes || 0),
      retryCount: 0,
    });
    if (!cancelled) {
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'RESTORE',
        title: `Khôi phục thất bại (Job #${jobId})`,
        message: errMsg,
        serverId: job?.target_server_id || job?.server_id || null,
        jobId,
      }).catch(() => {});
    }
    clearCancelledJob(jobId);
    emitJobUpdated(jobId);
    throw preErr;
  }

  const isCrossPanel =
    sourceServer.id !== targetServer.id ||
    sourceServer.panel_type !== targetServer.panel_type;

  const selectedDbsForSize = payload.selectedDatabases?.length
    ? item.databases_list.filter((d) =>
        payload.selectedDatabases!.includes(d.name)
      )
    : item.databases_list;
  const restoredDbSizeBytes =
    payload.mode === 'FILES_ONLY'
      ? 0
      : selectedDbsForSize.reduce(
          (acc, d) => acc + Math.max(0, Number(d.size_bytes || 0)),
          0
        );
  const restoredWebSizeBytes =
    payload.mode === 'DB_ONLY'
      ? 0
      : Math.max(0, Number(item.webroot_size_bytes || 0));
  const restoredTotalBytes = restoredWebSizeBytes + restoredDbSizeBytes;
  const effectiveTargetDomain =
    (payload.targetDomainName || item.domain_name || '').trim() ||
    item.domain_name;

  const logLines: string[] = [];
  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    logLines.push(line);
    if (logLines.length > 250) {
      logLines.shift();
    }
    db.prepare('UPDATE backup_jobs SET live_log = ? WHERE id = ?').run(
      logLines.join('\n'),
      jobId
    );
    emitJobLog({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      line,
      timestamp: ts,
    });
  };

  const setStep = (pct: number, phase: string) => {
    db.prepare(
      `UPDATE backup_jobs
       SET status = 'RUNNING',
           progress_percent = ?,
           current_phase = ?,
           current_domain = ?,
           total_size_bytes = ?
       WHERE id = ?`
    ).run(pct, phase, effectiveTargetDomain, restoredTotalBytes, jobId);
    emitJobProgress({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      status: 'RUNNING',
      progressPercent: pct,
      currentPhase: phase,
      currentDomain: effectiveTargetDomain,
      speedBps: 0,
      etaSeconds: 0,
      deltaSizeBytes: 0,
      totalSizeBytes: restoredTotalBytes,
      retryCount: 0,
    });
  };

  db.prepare(
    `UPDATE backup_jobs
     SET status = 'RUNNING',
         current_domain = ?,
         total_size_bytes = ?,
         started_at = COALESCE(started_at, datetime('now'))
     WHERE id = ?`
  ).run(effectiveTargetDomain, restoredTotalBytes, jobId);
  emitJobUpdated(jobId);

  const releaseSnapshotPin = acquireSnapshotReadPin(
    item.server_id,
    item.snapshot_name
  );

  try {
    if (isJobCancelled(jobId)) {
      throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
    }

    const targetDomain = assertSafe(
      isSafeDomain,
      (payload.targetDomainName || item.domain_name).trim(),
      'Tên miền đích'
    );
    const targetUser = assertSafe(
      isSafeSystemUser,
      (payload.targetSystemUser || item.system_user).trim(),
      'User hệ thống đích'
    );
    assertSafe(isSafeDomain, item.domain_name, 'Tên miền nguồn trong bản sao lưu');
    assertSafe(isSafeSnapshotName, item.snapshot_name, 'Snapshot nguồn');

    // Xác thực khóa định danh SSH Host Key (TOFU Pinning & Chống MITM) cho máy chủ đích trước khi kết nối SSH
    setStep(10, 'Đang xác thực khóa định danh SSH Host Key máy chủ đích (TOFU)...');
    const pinnedTarget = await ensureServerHostKeyPinned(targetServer.id);
    targetServer =
      (db
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get(targetServer.id) as unknown as ServerRecord | undefined) ||
      targetServer;
    appendLog(
      `[SSH TOFU] Xác thực khóa định danh máy chủ đích ${targetServer.hostname} (${pinnedTarget.status}: ${pinnedTarget.fingerprint}).`
    );

    const targetAdapter = getPanelAdapter(targetServer);

    let resolvedWebroot = assertSafe(
      (v) => isSafeWebroot(v.replace(/\/+$/, '')),
      payload.targetWebrootOverride?.trim() ||
        (await targetAdapter.resolveTargetWebroot(
          targetServer,
          targetUser,
          targetDomain
        )),
      'Webroot đích'
    );

    const sourceDomainDir = path.join(
      sourceVolume.mount_path,
      sourceServer.hostname,
      item.snapshot_name,
      'home',
      'domains',
      item.domain_name
    );
    const localPublicHtml = path.join(sourceDomainDir, 'public_html');
    const localDatabasesDir = path.join(sourceDomainDir, 'databases');
    const metadataPath = path.join(sourceDomainDir, 'metadata.json');
    let savedExcludedSubpaths: string[] = [];
    const shouldPreserveExcludedSubpaths =
      !payload.targetWebrootOverride?.trim() &&
      sourceServer.panel_type === targetServer.panel_type;
    if (shouldPreserveExcludedSubpaths && fs.existsSync(metadataPath)) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(metadataPath, 'utf8')
        ) as DomainMetadataJson;
        if (Array.isArray(meta.excluded_subpaths)) {
          savedExcludedSubpaths = meta.excluded_subpaths.filter(
            (s) => typeof s === 'string' && !s.includes('..') && !/[\r\n\0]/.test(s)
          );
        }
      } catch {
        // Ignore invalid metadata
      }
    }

    appendLog(
      isCrossPanel
        ? `🔄 Bắt đầu Di chuyển Chéo (Cross-Panel Restore): ${sourceServer.hostname} (${sourceServer.panel_type}) ➔ ${targetServer.hostname} (${targetServer.panel_type})`
        : `♻️ Bắt đầu Khôi phục dữ liệu (${payload.mode}) cho ${targetDomain} về ${targetServer.hostname} (${targetServer.panel_type})`
    );

    const mockRestoreDest = path.join(
      getDataDir(),
      'restored_preview',
      targetServer.hostname,
      targetDomain,
      'public_html'
    );

    // 1. Khôi phục Mã nguồn (Files)
    if (payload.mode === 'FILES_ONLY' || payload.mode === 'FULL') {
      if (isJobCancelled(jobId)) {
        throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
      }

      if (!fs.existsSync(localPublicHtml)) {
        throw new Error(
          `Không tìm thấy thư mục mã nguồn tại ${localPublicHtml}`
        );
      }

      setStep(20, `Đang kiểm tra an toàn & đẩy mã nguồn lên ${resolvedWebroot}...`);
      appendLog(
        `[Files Restore] Nguồn NAS: ${localPublicHtml} ➔ Đích VPS: ${targetServer.hostname}:${resolvedWebroot}`
      );

      if (targetServer.is_mock) {
        const mockPermCmd = targetAdapter.buildPermissionFixCommand(
          targetUser,
          targetDomain,
          resolvedWebroot
        );
        await new Promise((r) => setTimeout(r, 450));
        fs.mkdirSync(mockRestoreDest, { recursive: true });
        fs.cpSync(localPublicHtml, mockRestoreDest, {
          recursive: true,
          force: true,
        });
        setStep(55, `Đang chuẩn hóa phân quyền ${targetServer.panel_type}...`);
        await new Promise((r) => setTimeout(r, 300));
        appendLog(
          `[Permissions] Đã thực thi chuẩn hóa quyền trên ${targetServer.panel_type}: ${mockPermCmd}`
        );
      } else {
        const preSafety = await verifyRemoteWebrootSafety(
          targetServer,
          targetServer.panel_type,
          targetUser,
          resolvedWebroot,
          {
            mustExist: false,
            expectedDomain: targetDomain,
            parentDomain: item.parent_domain || undefined,
            jobId,
          }
        );
        if (!preSafety.ok) {
          throw new Error(
            `[SECURITY] Từ chối khôi phục mã nguồn vào đường dẫn không an toàn (${resolvedWebroot}): ${preSafety.reason}`
          );
        }

        // S15 Fix: Duyệt kiểm tra từng thành phần đường dẫn cha không phải symlink và tạo từng đoạn (tuyệt đối không fallback root `mkdir -p`)
        const safeMkdirScript = [
          'set -e',
          `TARGET=${shellSingleQuote(resolvedWebroot)}`,
          `SITE_USER=${shellSingleQuote(targetUser)}`,
          '[ ! -L "$TARGET" ] || exit 91',
          'CUR=""',
          'OLD_IFS="$IFS"',
          'IFS="/"',
          'for SEG in $TARGET; do',
          '  [ -n "$SEG" ] || continue',
          '  CUR="$CUR/$SEG"',
          '  if [ -L "$CUR" ]; then exit 91; fi',
          '  if [ ! -e "$CUR" ]; then',
          '    if [ "$SITE_USER" != "root" ] && [ "$(id -u)" = "0" ] && id -u "$SITE_USER" >/dev/null 2>&1; then',
          '      if command -v runuser >/dev/null 2>&1 && runuser -u "$SITE_USER" -- mkdir -- "$CUR" 2>/dev/null; then',
          '        :',
          '      else',
          '        mkdir -m 0755 -- "$CUR"',
          '        chown -h "$SITE_USER:$SITE_USER" -- "$CUR" 2>/dev/null || chown -h "$SITE_USER" -- "$CUR" 2>/dev/null || true',
          '      fi',
          '    else',
          '      mkdir -m 0755 -- "$CUR"',
          '    fi',
          '  elif [ ! -d "$CUR" ]; then',
          '    exit 91',
          '  fi',
          'done',
          'IFS="$OLD_IFS"',
        ].join('\n');
        const mkdirRes = await execRemoteSSH(targetServer, safeMkdirScript, {
          zeroImpact: true,
          jobId,
        });
        if (mkdirRes.code !== 0) {
          throw new Error(
            `Không thể tạo hoặc xác minh thư mục webroot đích ${resolvedWebroot} (code ${mkdirRes.code}): ${mkdirRes.stderr.trim()}`
          );
        }

        const liveSafety = await verifyRemoteWebrootSafety(
          targetServer,
          targetServer.panel_type,
          targetUser,
          resolvedWebroot,
          {
            mustExist: true,
            expectedDomain: targetDomain,
            parentDomain: item.parent_domain || undefined,
            jobId,
          }
        );
        if (!liveSafety.ok) {
          throw new Error(
            `[SECURITY] Từ chối khôi phục mã nguồn sau khi xác minh đường dẫn thực tế (${resolvedWebroot}): ${liveSafety.reason}`
          );
        }
        resolvedWebroot = liveSafety.resolvedPath;

        if (savedExcludedSubpaths.length > 0) {
          appendLog(
            `[Safe Restore] Bảo vệ thư mục Subdomain lồng bên trong (${savedExcludedSubpaths
              .map((s) => `/${s}`)
              .join(', ')}) không bị ghi đè/xóa khi khôi phục domain cha.`
          );
        }
        await pushFilesViaRsync({
          jobId,
          targetServer,
          targetUser,
          localPublicHtmlDir: localPublicHtml,
          targetWebroot: resolvedWebroot,
          excludedSubpaths: savedExcludedSubpaths,
          onProgress: (p) =>
            setStep(
              20 + Math.round(p * 0.35),
              `Đang đồng bộ mã nguồn (${p}%)...`
            ),
        });
        const permCmd = targetAdapter.buildPermissionFixCommand(
          targetUser,
          targetDomain,
          resolvedWebroot
        );
        setStep(58, `Đang gán quyền chủ sở hữu (${targetServer.panel_type})...`);
        // N11 & N28 Fix: Cấp timeout 15 phút và đăng ký jobId để lệnh chown/chmod có thể hủy tức thì
        const chownRes = await execRemoteSSH(targetServer, permCmd, {
          zeroImpact: true,
          timeoutMs: RESTORE_PERMISSION_FIX_TIMEOUT_MS,
          jobId,
        });
        if (chownRes.code !== 0) {
          appendLog(
            `[Cảnh báo] Lệnh phân quyền trả về mã ${chownRes.code}: ${chownRes.stderr.trim()}`
          );
        } else {
          appendLog(`[Permissions] Đã thực thi thành công: ${permCmd}`);
        }
      }
    }

    // Trích xuất thông tin kết nối Database (DB_NAME, DB_USER, DB_PASSWORD, DB_HOST) từ wp-config.php / .env / configuration.php
    let extractedConfigs = extractDbCredentialsFromDirectory(localPublicHtml);
    if (
      extractedConfigs.length === 0 &&
      !targetServer.is_mock &&
      payload.mode === 'DB_ONLY'
    ) {
      extractedConfigs = await extractDbCredentialsFromRemoteWebrootOverSsh({
        server: targetServer,
        targetUser,
        targetDomain,
        targetWebroot: resolvedWebroot,
        jobId,
      }).catch(() => []);
    }

    for (const cfg of extractedConfigs) {
      appendLog(
        `[Web Config] Đọc cấu hình ${cfg.sourceFile} ➔ DB_NAME="${cfg.dbName}", DB_USER="${cfg.dbUser || '(trống)'}", DB_HOST="${cfg.dbHost || 'localhost'}"${cfg.dbPassword !== undefined ? ' (đã trích xuất DB_PASSWORD)' : ''}.`
      );
    }

    // Tự động bổ sung file dump SQL từ thư mục databases cục bộ nếu metadata item.databases_list bị thiếu
    const availableDatabases: DatabaseBackupInfo[] = [...item.databases_list];
    if (fs.existsSync(localDatabasesDir)) {
      try {
        const existingFiles = new Set(availableDatabases.map((d) => d.file));
        const dirEntries = fs.readdirSync(localDatabasesDir);
        for (const entryName of dirEntries) {
          if (existingFiles.has(entryName)) continue;
          const matchDump = entryName.match(/^(.+?)\.sql(?:\.zst|\.gz)?$/i);
          if (!matchDump) continue;
          const rawBase = matchDump[1];
          const isPgDump = rawBase.startsWith('pg_');
          const inferredDbName = isPgDump ? rawBase.slice(3) : rawBase;
          if (!isSafeDbName(inferredDbName)) continue;
          const fullDumpPath = path.join(localDatabasesDir, entryName);
          const st = fs.lstatSync(fullDumpPath, { throwIfNoEntry: false });
          if (!st || !st.isFile() || st.isSymbolicLink()) continue;
          const matchedCfg =
            extractedConfigs.find((c) => c.dbName === inferredDbName) ||
            (extractedConfigs.length === 1 ? extractedConfigs[0] : undefined);
          availableDatabases.push({
            name: inferredDbName,
            file: entryName,
            size_bytes: st.size,
            db_user: matchedCfg?.dbUser || targetUser,
            engine: isPgDump ? 'POSTGRESQL' : 'MYSQL',
          });
        }
      } catch {
        // Ignore directory scan errors
      }
    }

    const effectiveDbRenameMap: Record<string, string> = {
      ...(payload.targetDbMap || {}),
    };
    const provisionedDbNames = new Set<string>();
    let cachedMysqlCreds: MysqlAdminCredentials | null = null;

    // 2. Khôi phục Database & Tự động khởi tạo User / Mapping quyền truy cập
    if (payload.mode === 'DB_ONLY' || payload.mode === 'FULL') {
      const dbsToRestore: DatabaseBackupInfo[] = payload.selectedDatabases?.length
        ? availableDatabases.filter((d) =>
            payload.selectedDatabases!.includes(d.name)
          )
        : availableDatabases;

      if (dbsToRestore.length === 0) {
        appendLog(
          `[DB Restore] Không có file dump SQL nào trong bản sao lưu${extractedConfigs.length > 0 ? '; sẽ kiểm tra khởi tạo DB/User rỗng từ tệp cấu hình web' : ''}.`
        );
      } else {
        const needsMysqlCreds = dbsToRestore.some(
          (d) => !(d.engine === 'POSTGRESQL' || d.file.startsWith('pg_'))
        );
        if (needsMysqlCreds) {
          cachedMysqlCreds =
            await targetAdapter.getMysqlAdminCredentials(targetServer);
        }

        for (let i = 0; i < dbsToRestore.length; i++) {
          if (isJobCancelled(jobId)) {
            throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
          }

          const dbInfo = dbsToRestore[i];
          const isPostgres =
            dbInfo.engine === 'POSTGRESQL' || dbInfo.file.startsWith('pg_');
          const targetDbName = assertSafe(
            isSafeDbName,
            effectiveDbRenameMap[dbInfo.name]?.trim() || dbInfo.name,
            'Tên database đích'
          );

          const matchedConfig: ExtractedWebDbConfig | undefined =
            extractedConfigs.find(
              (c) => c.dbName === dbInfo.name || c.dbName === targetDbName
            ) ||
            (dbsToRestore.length === 1 && extractedConfigs.length === 1
              ? extractedConfigs[0]
              : undefined);

          if (
            matchedConfig &&
            matchedConfig.dbName !== targetDbName &&
            isSafeDbName(matchedConfig.dbName)
          ) {
            effectiveDbRenameMap[matchedConfig.dbName] = targetDbName;
          }

          if (
            !dbInfo.file ||
            path.basename(dbInfo.file) !== dbInfo.file ||
            dbInfo.file.includes('..') ||
            /[/\\\0]/.test(dbInfo.file)
          ) {
            throw new Error(
              `Tên file dump SQL không hợp lệ: ${JSON.stringify(dbInfo.file)}`
            );
          }

          const dumpPath = path.join(localDatabasesDir, dbInfo.file);

          if (!fs.existsSync(dumpPath)) {
            throw new Error(`Không tìm thấy file backup SQL tại ${dumpPath}`);
          }

          setStep(
            65 + Math.round(((i + 1) / dbsToRestore.length) * 30),
            `Đang giải nén luồng & nạp ${isPostgres ? 'PostgreSQL' : 'MySQL'} Database ${targetDbName}...`
          );

          if (isPostgres) {
            const pgUser =
              matchedConfig?.dbUser || dbInfo.db_user || targetUser;
            appendLog(
              `[PG Stream Restore] Stream ${dbInfo.file} ➔ PostgreSQL(${targetServer.hostname}) / DB: ${targetDbName} (User: ${pgUser})`
            );

            if (targetServer.is_mock) {
              await new Promise((r) => setTimeout(r, 450));
              appendLog(
                `[PG Stream Restore] ✅ Đã nạp thành công toàn bộ bảng PostgreSQL vào database "${targetDbName}" trên ${targetServer.hostname}.`
              );
            } else {
              await streamRestorePostgresOverSsh({
                jobId,
                targetServer,
                dumpFilePath: dumpPath,
                targetDbName,
                targetDbUser: pgUser,
              });
              appendLog(
                `[PG Stream Restore] ✅ Hoàn tất nạp PostgreSQL Database "${targetDbName}".`
              );
            }
          } else {
            const dbUserToProvision = (
              matchedConfig?.dbUser ||
              dbInfo.db_user ||
              ''
            ).trim();
            const dbPasswordToProvision = matchedConfig?.dbPassword;
            const dbHostToProvision = matchedConfig?.dbHost || 'localhost';

            const provisionPlan = buildMysqlProvisionDatabaseAndUserScript({
              creds: cachedMysqlCreds || { user: 'root' },
              targetDbName,
              dbUser: dbUserToProvision,
              dbPassword: dbPasswordToProvision,
              dbHost: dbHostToProvision,
              panelType: targetServer.panel_type,
              targetSystemUser: targetUser,
            });

            appendLog(
              `[DB Stream Restore] Stream ${dbInfo.file} ➔ MySQL(${targetServer.hostname}) / DB: ${targetDbName}`
            );

            if (targetServer.is_mock) {
              await new Promise((r) => setTimeout(r, 450));
              if (provisionPlan.provisionedUser) {
                appendLog(
                  `[DB Provision] ✅ Đã khởi tạo MySQL User "${provisionPlan.provisionedUser}" và gán quyền (ALL PRIVILEGES) vào Database "${targetDbName}"${matchedConfig ? ` (từ ${matchedConfig.sourceFile})` : ''}.`
                );
              }
              appendLog(
                `[DB Stream Restore] ✅ Đã nạp thành công toàn bộ bảng vào database "${targetDbName}" trên ${targetServer.hostname}.`
              );
            } else {
              const createRes = await execRemoteSSH(
                targetServer,
                provisionPlan.createDbCommand,
                {
                  zeroImpact: true,
                  jobId,
                }
              );
              if (createRes.code !== 0) {
                throw new Error(
                  `Không thể khởi tạo database đích "${targetDbName}": ${createRes.stderr.trim()}`
                );
              }

              if (provisionPlan.provisionUserCommand) {
                const userRes = await execRemoteSSH(
                  targetServer,
                  provisionPlan.provisionUserCommand,
                  {
                    zeroImpact: true,
                    jobId,
                  }
                );
                if (userRes.code === 0) {
                  if (provisionPlan.provisionedUser) {
                    appendLog(
                      `[DB Provision] ✅ Đã khởi tạo MySQL User "${provisionPlan.provisionedUser}" và gán quyền (ALL PRIVILEGES) vào Database "${targetDbName}"${matchedConfig ? ` (từ ${matchedConfig.sourceFile})` : ''}.`
                    );
                  }
                } else {
                  appendLog(
                    `[Cảnh báo] Khởi tạo User/Grant cho Database "${targetDbName}" trả về mã ${userRes.code}: ${userRes.stderr.trim()}`
                  );
                }
              }

              await streamRestoreDatabaseOverSsh({
                jobId,
                targetServer,
                creds: cachedMysqlCreds!,
                dumpFilePath: dumpPath,
                targetDbName,
              });

              await registerRestoredDatabaseInPanel({
                targetServer,
                creds: cachedMysqlCreds!,
                targetUser,
                targetDomain,
                targetDbName,
                dbUser:
                  provisionPlan.provisionedUser ||
                  dbUserToProvision ||
                  targetUser,
                dbPassword: dbPasswordToProvision,
                jobId,
                onLog: appendLog,
              });

              appendLog(
                `[DB Stream Restore] ✅ Hoàn tất nạp Database "${targetDbName}".`
              );
            }
          }

          provisionedDbNames.add(dbInfo.name);
          provisionedDbNames.add(targetDbName);
          if (matchedConfig) {
            provisionedDbNames.add(matchedConfig.dbName);
          }
        }
      }
    }

    // 2b. Nếu tệp cấu hình (wp-config.php / .env / configuration.php) khai báo DB/User chưa có trong danh sách dump SQL,
    // tự động khởi tạo Database + MySQL User + Password + Mapping để website kết nối được ngay không cần tạo thủ công.
    const unprovisionedConfigs = extractedConfigs.filter(
      (c) => !provisionedDbNames.has(c.dbName)
    );
    if (unprovisionedConfigs.length > 0) {
      if (!cachedMysqlCreds && !targetServer.is_mock) {
        try {
          cachedMysqlCreds =
            await targetAdapter.getMysqlAdminCredentials(targetServer);
        } catch (credErr) {
          appendLog(
            `[Cảnh báo] Không thể lấy thông tin quản trị MySQL để khởi tạo DB từ cấu hình web: ${(credErr as Error).message}`
          );
        }
      }

      for (const cfg of unprovisionedConfigs) {
        const targetDbName = assertSafe(
          isSafeDbName,
          effectiveDbRenameMap[cfg.dbName]?.trim() || cfg.dbName,
          'Tên database đích'
        );
        const provisionPlan = buildMysqlProvisionDatabaseAndUserScript({
          creds: cachedMysqlCreds || { user: 'root' },
          targetDbName,
          dbUser: cfg.dbUser,
          dbPassword: cfg.dbPassword,
          dbHost: cfg.dbHost,
          panelType: targetServer.panel_type,
          targetSystemUser: targetUser,
        });

        if (targetServer.is_mock) {
          appendLog(
            `[DB Provision] ✅ Đã tự động khởi tạo Database "${targetDbName}"${provisionPlan.provisionedUser ? ` & MySQL User "${provisionPlan.provisionedUser}" (ALL PRIVILEGES)` : ''} từ ${cfg.sourceFile}.`
          );
          provisionedDbNames.add(cfg.dbName);
          provisionedDbNames.add(targetDbName);
        } else if (cachedMysqlCreds) {
          const createRes = await execRemoteSSH(
            targetServer,
            provisionPlan.createDbCommand,
            {
              zeroImpact: true,
              jobId,
            }
          );
          if (createRes.code === 0) {
            if (provisionPlan.provisionUserCommand) {
              await execRemoteSSH(
                targetServer,
                provisionPlan.provisionUserCommand,
                {
                  zeroImpact: true,
                  jobId,
                }
              );
            }
            await registerRestoredDatabaseInPanel({
              targetServer,
              creds: cachedMysqlCreds,
              targetUser,
              targetDomain,
              targetDbName,
              dbUser: provisionPlan.provisionedUser || cfg.dbUser || targetUser,
              dbPassword: cfg.dbPassword,
              jobId,
              onLog: appendLog,
            });
            appendLog(
              `[DB Provision] ✅ Đã tự động khởi tạo Database "${targetDbName}"${provisionPlan.provisionedUser ? ` & MySQL User "${provisionPlan.provisionedUser}" (ALL PRIVILEGES)` : ''} từ ${cfg.sourceFile}.`
            );
            provisionedDbNames.add(cfg.dbName);
            provisionedDbNames.add(targetDbName);
          } else {
            appendLog(
              `[Cảnh báo] Không thể khởi tạo Database "${targetDbName}" từ ${cfg.sourceFile}: ${createRes.stderr.trim()}`
            );
          }
        }
      }
    }

    // 3. Tự động cập nhật cấu hình kết nối DB & đường dẫn Webroot khi Di chuyển Chéo (Cross-Panel Config Rewriter)
    if (payload.autoPatchConfig && payload.mode !== 'DB_ONLY') {
      setStep(96, 'Đang tự động hiệu chỉnh cấu hình kết nối Web / Database...');
      const patchRes = await patchRestoredWebConfigOverSsh({
        server: targetServer,
        targetUser,
        targetDomain,
        targetWebroot: resolvedWebroot,
        sourceWebroot: item.source_webroot || '',
        dbRenameMap: effectiveDbRenameMap,
        isMock: Boolean(targetServer.is_mock),
        mockWebrootDir: targetServer.is_mock ? mockRestoreDest : undefined,
        jobId,
        onLog: appendLog,
      });

      if (patchRes.patchedFiles.length > 0) {
        if (!targetServer.is_mock) {
          const postPatchPermCmd = targetAdapter.buildPermissionFixCommand(
            targetUser,
            targetDomain,
            resolvedWebroot
          );
          const reChown = await execRemoteSSH(targetServer, postPatchPermCmd, {
            zeroImpact: true,
            timeoutMs: RESTORE_PERMISSION_FIX_TIMEOUT_MS,
            jobId,
          });
          if (reChown.code !== 0) {
            appendLog(
              `[Cảnh báo] Lệnh chuẩn hóa lại quyền sau khi cập nhật cấu hình trả về mã ${reChown.code}: ${reChown.stderr.trim()}`
            );
          }
        }
        appendLog(
          `[Config Rewriter] ✅ Đã cập nhật thành công ${patchRes.patchedFiles.length} tệp cấu hình: ${patchRes.patchedFiles.join(', ')}.`
        );
      } else {
        appendLog(
          `[Config Rewriter] Không phát hiện thông số DB / đường dẫn cũ cần sửa đổi trong các tệp cấu hình.`
        );
      }
    }

    db.prepare(
      `UPDATE backup_jobs
       SET status = 'COMPLETED',
           progress_percent = 100,
           current_phase = 'Khôi phục hoàn tất 100%',
           current_domain = ?,
           total_size_bytes = ?,
           speed_bps = 0,
           eta_seconds = 0,
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(targetDomain, restoredTotalBytes, jobId);

    appendLog(
      `🎉 Khôi phục ${targetDomain} sang ${targetServer.hostname} (${targetServer.panel_type}) hoàn tất 100%!`
    );

    emitJobProgress({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      status: 'COMPLETED',
      progressPercent: 100,
      currentPhase: 'Khôi phục hoàn tất 100%',
      currentDomain: targetDomain,
      speedBps: 0,
      etaSeconds: 0,
      deltaSizeBytes: 0,
      totalSizeBytes: restoredTotalBytes,
      retryCount: 0,
    });

    await createSystemAlert({
      severity: 'INFO',
      category: 'RESTORE',
      title: `Khôi phục thành công ${targetDomain} ➔ ${targetServer.hostname}`,
      message: `Chế độ: ${payload.mode} | Nguồn: ${sourceServer.hostname} (${item.snapshot_name}) | Đích: ${targetServer.hostname} (${targetServer.panel_type} - ${resolvedWebroot}).`,
      serverId: targetServer.id,
      jobId,
      notifyExternal: false,
    });

    emitJobUpdated(jobId);
  } catch (err) {
    const cancelled = isJobCancelled(jobId);
    const errMsg = (err as Error).message;
    const terminalStatus = cancelled ? 'CANCELLED' : 'FAILED';
    const terminalPhase = cancelled
      ? 'Đã hủy bởi quản trị viên'
      : 'Khôi phục thất bại';
    appendLog(
      cancelled
        ? `⏹️ Phiên khôi phục đã bị hủy: ${errMsg}`
        : `❌ Khôi phục thất bại: ${errMsg}`
    );
    const currentPctRow = db
      .prepare('SELECT progress_percent FROM backup_jobs WHERE id = ?')
      .get(jobId);
    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, current_phase = ?, speed_bps = 0, eta_seconds = 0, completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(terminalStatus, terminalPhase, errMsg, jobId);

    emitJobProgress({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      status: terminalStatus,
      progressPercent: Number(currentPctRow?.progress_percent ?? 0),
      currentPhase: terminalPhase,
      currentDomain: effectiveTargetDomain,
      speedBps: 0,
      etaSeconds: 0,
      deltaSizeBytes: 0,
      totalSizeBytes: restoredTotalBytes,
      retryCount: 0,
    });

    if (!cancelled) {
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'RESTORE',
        title: `Khôi phục thất bại cho ${item.domain_name}`,
        message: errMsg,
        serverId: targetServer.id,
        jobId,
      });
    }

    emitJobUpdated(jobId);
    throw err;
  } finally {
    releaseSnapshotPin();
    clearCancelledJob(jobId);
  }
}

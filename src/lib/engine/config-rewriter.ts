import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/db';
import {
  buildSshBaseArgs,
  execRemoteSSH,
  shellSingleQuote,
  wrapZeroImpact,
} from '@/lib/ssh';
import type { ServerRecord } from '@/types';
import {
  assertSafe,
  isSafeDbName,
  isSafeDomain,
  isSafeSystemUser,
  isSafeWebroot,
} from './safe-names';
import {
  DETACHED_PROCESS_GROUP,
  terminateChildGracefully,
} from './worker-state';

const CANDIDATE_CONFIG_FILES = [
  'wp-config.php',
  '.env',
  'configuration.php',
  'config.php',
  'app/etc/env.php',
] as const;

const MAX_CONFIG_FILE_BYTES = 256 * 1024; // 256 KB

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveEffectiveSiteUser(
  server: ServerRecord,
  targetUser: string
): string {
  const clean = targetUser.trim();
  if (server.panel_type === 'AAPANEL' && (!clean || clean === 'root')) {
    return 'www';
  }
  return clean || 'root';
}

function wrapPrivilegeDropToSiteUser(
  siteUser: string,
  innerWorkerScript: string
): string {
  assertSafe(isSafeSystemUser, siteUser, 'siteUser');
  const quotedUser = shellSingleQuote(siteUser);
  const quotedInner = shellSingleQuote(innerWorkerScript);
  return [
    `SITE_USER=${quotedUser}`,
    `INNER_SCRIPT=${quotedInner}`,
    'if [ "$SITE_USER" != "root" ] && [ "$(id -u)" = "0" ] && id -u "$SITE_USER" >/dev/null 2>&1; then',
    '  if command -v runuser >/dev/null 2>&1; then',
    '    exec runuser -u "$SITE_USER" -- sh -c "$INNER_SCRIPT"',
    '  else',
    '    exec su -s /bin/sh "$SITE_USER" -c "$INNER_SCRIPT"',
    '  fi',
    'else',
    '  exec sh -c "$INNER_SCRIPT"',
    'fi',
  ].join('\n');
}

/**
 * S2 Security Fix: Kiểm tra từng thành phần đường dẫn không chứa symlink, hạ quyền xuống user của site,
 * và dùng `mktemp` (O_CREAT|O_EXCL) kết hợp `mv -f` (rename nguyên tử không đi theo symlink đích) để chặn tuyệt đối
 * kịch bản tạo sẵn `wp-config.php.nas-sync.bak -> /root/.ssh/authorized_keys`.
 */
export function buildSafeConfigWriteScript(
  cleanTargetWebroot: string,
  relFile: string,
  siteUser: string
): string {
  assertSafe((v) => isSafeWebroot(v, 2), cleanTargetWebroot, 'cleanTargetWebroot');
  assertSafe(isSafeSystemUser, siteUser, 'siteUser');
  if (
    !CANDIDATE_CONFIG_FILES.includes(
      relFile as (typeof CANDIDATE_CONFIG_FILES)[number]
    )
  ) {
    throw new Error(`Tệp cấu hình không nằm trong danh sách cho phép: ${relFile}`);
  }

  const workerBody = [
    'set -e',
    `WEBROOT=${shellSingleQuote(cleanTargetWebroot)}`,
    `REL=${shellSingleQuote(relFile)}`,
    '[ ! -L "$WEBROOT" ]',
    'REAL_ROOT=$(realpath -e -- "$WEBROOT")',
    'CUR="$REAL_ROOT"',
    'OLD_IFS="$IFS"',
    'IFS="/"',
    'for SEG in $REL; do',
    '  [ -z "$SEG" ] && continue',
    '  CUR="$CUR/$SEG"',
    '  [ ! -L "$CUR" ] || exit 92',
    'done',
    'IFS="$OLD_IFS"',
    'F="$CUR"',
    '[ -f "$F" ] && [ ! -L "$F" ]',
    'D_DIR=$(dirname -- "$F")',
    '[ -d "$D_DIR" ] && [ ! -L "$D_DIR" ]',
    'REAL_F=$(realpath -e -- "$F")',
    'case "$REAL_F" in "$REAL_ROOT"/*) ;; *) exit 92 ;; esac',
    'BAK_TMP=$(mktemp "$D_DIR/.nas-sync-bak.XXXXXX")',
    'TMP_NEW=$(mktemp "$D_DIR/.nas-sync-tmp.XXXXXX")',
    'trap \'rm -f -- "$BAK_TMP" "$TMP_NEW"\' EXIT',
    'cp -P -- "$REAL_F" "$BAK_TMP"',
    'chmod 600 -- "$BAK_TMP"',
    'cat > "$TMP_NEW"',
    'chmod --reference="$REAL_F" "$TMP_NEW" 2>/dev/null || chmod 640 "$TMP_NEW"',
    'if [ "$(id -u)" = "0" ]; then chown --reference="$REAL_F" "$BAK_TMP" "$TMP_NEW" 2>/dev/null || true; fi',
    'rm -f -- "$REAL_F.nas-sync.bak"',
    'mv -f -- "$BAK_TMP" "$REAL_F.nas-sync.bak"',
    'mv -f -- "$TMP_NEW" "$REAL_F"',
    'trap - EXIT',
  ].join('\n');

  return wrapPrivilegeDropToSiteUser(siteUser, workerBody);
}

export function buildSafeConfigReadScript(
  cleanTargetWebroot: string,
  relFile: string,
  siteUser: string
): string {
  assertSafe((v) => isSafeWebroot(v, 2), cleanTargetWebroot, 'cleanTargetWebroot');
  assertSafe(isSafeSystemUser, siteUser, 'siteUser');
  if (
    !CANDIDATE_CONFIG_FILES.includes(
      relFile as (typeof CANDIDATE_CONFIG_FILES)[number]
    )
  ) {
    throw new Error(`Tệp cấu hình không nằm trong danh sách cho phép: ${relFile}`);
  }

  const workerBody = [
    'set -e',
    `WEBROOT=${shellSingleQuote(cleanTargetWebroot)}`,
    `REL=${shellSingleQuote(relFile)}`,
    '[ ! -L "$WEBROOT" ]',
    'REAL_ROOT=$(realpath -e -- "$WEBROOT")',
    'CUR="$REAL_ROOT"',
    'OLD_IFS="$IFS"',
    'IFS="/"',
    'for SEG in $REL; do',
    '  [ -z "$SEG" ] && continue',
    '  CUR="$CUR/$SEG"',
    '  [ ! -L "$CUR" ] || exit 92',
    'done',
    'IFS="$OLD_IFS"',
    'F="$CUR"',
    '[ -f "$F" ] && [ ! -L "$F" ]',
    'REAL_F=$(realpath -e -- "$F")',
    'case "$REAL_F" in "$REAL_ROOT"/*) ;; *) exit 92 ;; esac',
    'SZ=$(wc -c < "$REAL_F" | tr -d "[:space:]")',
    `[ -n "$SZ" ] && [ "$SZ" -gt 0 ] && [ "$SZ" -le ${MAX_CONFIG_FILE_BYTES} ]`,
    'cat -- "$REAL_F"',
  ].join('\n');

  return wrapPrivilegeDropToSiteUser(siteUser, workerBody);
}

export function applyConfigReplacements(
  fileName: string,
  content: string,
  options: {
    changedDbs: Array<[string, string]>;
    sourceWebroot?: string;
    targetWebroot?: string;
  }
): string {
  const normRel = fileName.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.posix.basename(normRel);
  let next = content;

  for (const [oldDb, newDb] of options.changedDbs) {
    if (!oldDb || !newDb || oldDb === newDb) continue;
    const escapedOld = escapeRegExp(oldDb);

    if (baseName === 'wp-config.php') {
      const wpDbRe = new RegExp(
        `define\\(\\s*(['"])DB_NAME\\1\\s*,\\s*(['"])${escapedOld}\\2\\s*\\)`,
        'g'
      );
      next = next.replace(
        wpDbRe,
        (_m, q1: string, q2: string) =>
          `define(${q1}DB_NAME${q1}, ${q2}${newDb}${q2})`
      );
    } else if (baseName === '.env') {
      const envDbRe = new RegExp(
        `^([ \\t]*(?:export[ \\t]+)?DB_DATABASE[ \\t]*=[ \\t]*["']?)${escapedOld}(["']?[ \\t]*\\r?)$`,
        'gm'
      );
      next = next.replace(
        envDbRe,
        (_m, pre: string, post: string) => `${pre}${newDb}${post}`
      );
    } else if (baseName === 'configuration.php') {
      const joomlaDbRe = new RegExp(
        `(\\$db\\s*=\\s*(['"]))${escapedOld}(\\2)`,
        'g'
      );
      next = next.replace(
        joomlaDbRe,
        (_m, pre: string, _q: string, post: string) => `${pre}${newDb}${post}`
      );
    } else if (baseName === 'config.php' || normRel === 'app/etc/env.php') {
      const defineDbRe = new RegExp(
        `define\\(\\s*(['"])(DB_DATABASE|DB_NAME)\\1\\s*,\\s*(['"])${escapedOld}\\3\\s*\\)`,
        'gi'
      );
      next = next.replace(
        defineDbRe,
        (_m, q1: string, key: string, q2: string) =>
          `define(${q1}${key}${q1}, ${q2}${newDb}${q2})`
      );

      const arrayDbRe = new RegExp(
        `((['"])(?:dbname|database|db_name)\\2\\s*=>\\s*(['"]))${escapedOld}(\\3)`,
        'gi'
      );
      next = next.replace(
        arrayDbRe,
        (_m, pre: string, _kq: string, _vq: string, post: string) =>
          `${pre}${newDb}${post}`
      );

      const varDbRe = new RegExp(
        `(\\$(?:dbname|db_name|database)\\s*=\\s*(['"]))${escapedOld}(\\2)`,
        'gi'
      );
      next = next.replace(
        varDbRe,
        (_m, pre: string, _q: string, post: string) => `${pre}${newDb}${post}`
      );
    }
  }

  const cleanSrcRoot = (options.sourceWebroot || '').trim().replace(/\/+$/, '');
  const cleanDstRoot = (options.targetWebroot || '').trim().replace(/\/+$/, '');
  if (cleanSrcRoot && cleanDstRoot && cleanSrcRoot !== cleanDstRoot) {
    next = next.split(cleanSrcRoot).join(cleanDstRoot);
  }

  return next;
}

function writeRemoteFileAtomicallyOverSsh(
  server: ServerRecord,
  cleanTargetWebroot: string,
  relFile: string,
  siteUser: string,
  content: string,
  timeoutMs = 20000
): Promise<void> {
  const sshUser = (server.ssh_user || 'root').trim();
  const ipAddr = (server.ip_address || '').trim();
  const innerScript = buildSafeConfigWriteScript(
    cleanTargetWebroot,
    relFile,
    siteUser
  );

  const remoteCmd = wrapZeroImpact(innerScript);
  const args = [
    ...buildSshBaseArgs(server),
    '--',
    `${sshUser}@${ipAddr}`,
    remoteCmd,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: DETACHED_PROCESS_GROUP,
    });

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        terminateChildGracefully(child);
        reject(
          new Error(`Quá thời gian chờ khi ghi cấu hình ${relFile} qua SSH.`)
        );
      }
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `Không thể cập nhật tệp cấu hình ${relFile} trên VPS (code ${code}): ${stderr.trim()}`
          )
        );
      }
    });

    child.stdin.on('error', () => {
      // Đã xử lý qua sự kiện close/error của tiến trình ssh
    });
    child.stdin.end(Buffer.from(content, 'utf8'));
  });
}

function hasAnySymlinkAlongRelativePath(
  rootDir: string,
  relFile: string
): boolean {
  const segments = relFile.split('/').filter(Boolean);
  let cur = rootDir;
  for (const seg of segments) {
    cur = path.join(cur, seg);
    const lst = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!lst || lst.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

export async function patchRestoredWebConfigOverSsh(params: {
  server: ServerRecord;
  targetUser: string;
  targetDomain: string;
  targetWebroot: string;
  sourceWebroot: string;
  dbRenameMap: Record<string, string>;
  isMock: boolean;
  mockWebrootDir?: string;
  onLog: (msg: string) => void;
}): Promise<{ patchedFiles: string[] }> {
  const { server, targetUser, targetDomain, onLog } = params;

  const changedDbs: Array<[string, string]> = [];
  for (const [rawOld, rawNew] of Object.entries(params.dbRenameMap || {})) {
    const oldDb = rawOld.trim();
    const newDb = String(rawNew || '').trim();
    if (!oldDb || !newDb || oldDb === newDb) continue;
    if (!isSafeDbName(oldDb) || !isSafeDbName(newDb)) {
      throw new Error(
        `Tên Database trong bảng ánh xạ cấu hình không hợp lệ: ${JSON.stringify(
          oldDb
        )} ➔ ${JSON.stringify(newDb)}`
      );
    }
    changedDbs.push([oldDb, newDb]);
  }

  const cleanSourceWebroot = (params.sourceWebroot || '').trim().replace(/\/+$/, '');
  const cleanTargetWebroot = (params.targetWebroot || '').trim().replace(/\/+$/, '');

  const webrootChanged = Boolean(
    cleanSourceWebroot &&
      cleanTargetWebroot &&
      cleanSourceWebroot !== cleanTargetWebroot &&
      isSafeWebroot(cleanSourceWebroot) &&
      isSafeWebroot(cleanTargetWebroot)
  );

  if (changedDbs.length === 0 && !webrootChanged) {
    return { patchedFiles: [] };
  }

  const patchedFiles: string[] = [];

  if (params.isMock) {
    const rootDir =
      params.mockWebrootDir ||
      path.join(
        getDataDir(),
        'restored_preview',
        server.hostname,
        targetDomain,
        'public_html'
      );
    if (!fs.existsSync(rootDir)) {
      return { patchedFiles: [] };
    }

    const rootStat = fs.lstatSync(rootDir, { throwIfNoEntry: false });
    if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { patchedFiles: [] };
    }

    const realRoot = fs.realpathSync(rootDir);
    for (const relFile of CANDIDATE_CONFIG_FILES) {
      const fullPath = path.resolve(rootDir, relFile);
      if (!fs.existsSync(fullPath)) continue;
      if (hasAnySymlinkAlongRelativePath(rootDir, relFile)) continue;

      const lst = fs.lstatSync(fullPath);
      if (
        !lst.isFile() ||
        lst.isSymbolicLink() ||
        lst.size === 0 ||
        lst.size > MAX_CONFIG_FILE_BYTES
      ) {
        continue;
      }

      const realFile = fs.realpathSync(fullPath);
      if (!realFile.startsWith(realRoot + path.sep)) {
        continue;
      }

      const original = fs.readFileSync(fullPath, 'utf8');
      if (original.includes('\0')) continue;

      const updated = applyConfigReplacements(relFile, original, {
        changedDbs,
        sourceWebroot: webrootChanged ? cleanSourceWebroot : undefined,
        targetWebroot: webrootChanged ? cleanTargetWebroot : undefined,
      });

      if (updated !== original) {
        const parentDir = path.dirname(fullPath);
        const nonce = crypto.randomBytes(6).toString('hex');
        const bakTmp = path.join(parentDir, `.nas-sync-bak.${nonce}`);
        const newTmp = path.join(parentDir, `.nas-sync-tmp.${nonce}`);
        const bakPath = `${fullPath}.nas-sync.bak`;
        try {
          fs.writeFileSync(bakTmp, original, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
          });
          fs.writeFileSync(newTmp, updated, {
            encoding: 'utf8',
            mode: 0o640,
            flag: 'wx',
          });
          fs.rmSync(bakPath, { force: true });
          fs.renameSync(bakTmp, bakPath);
          fs.renameSync(newTmp, fullPath);
        } finally {
          fs.rmSync(bakTmp, { force: true });
          fs.rmSync(newTmp, { force: true });
        }
        patchedFiles.push(relFile);
        onLog(
          `[Config Rewriter] Đã tự động cập nhật cấu hình ${relFile} (sao lưu bản gốc tại ${relFile}.nas-sync.bak).`
        );
      }
    }

    return { patchedFiles };
  }

  if (
    !isSafeWebroot(cleanTargetWebroot) ||
    !isSafeSystemUser(targetUser) ||
    !isSafeDomain(targetDomain)
  ) {
    throw new Error('Thông số mục tiêu không hợp lệ để cập nhật file cấu hình.');
  }

  const effectiveSiteUser = resolveEffectiveSiteUser(server, targetUser);

  const quotedCandidates = CANDIDATE_CONFIG_FILES.map((c) =>
    shellSingleQuote(c)
  ).join(' ');
  const probeScript = [
    `WEBROOT=${shellSingleQuote(cleanTargetWebroot)}`,
    '[ ! -L "$WEBROOT" ] || exit 0',
    'REAL_ROOT=$(realpath -e -- "$WEBROOT" 2>/dev/null) || exit 0',
    `for REL in ${quotedCandidates}; do`,
    '  CUR="$REAL_ROOT"',
    '  BAD_LINK=0',
    '  OLD_IFS="$IFS"',
    '  IFS="/"',
    '  for SEG in $REL; do',
    '    [ -z "$SEG" ] && continue',
    '    CUR="$CUR/$SEG"',
    '    if [ -L "$CUR" ]; then BAD_LINK=1; break; fi',
    '  done',
    '  IFS="$OLD_IFS"',
    '  [ "$BAD_LINK" = "0" ] || continue',
    '  F="$CUR"',
    '  if [ -f "$F" ] && [ ! -L "$F" ]; then',
    '    REAL_F=$(realpath -e -- "$F" 2>/dev/null || true)',
    '    case "$REAL_F" in',
    '      "$REAL_ROOT"/*)',
    '        SZ=$(wc -c < "$REAL_F" 2>/dev/null | tr -d "[:space:]")',
    `        if [ -n "$SZ" ] && [ "$SZ" -gt 0 ] && [ "$SZ" -le ${MAX_CONFIG_FILE_BYTES} ]; then`,
    '          printf "%s\\n" "$REL"',
    '        fi',
    '        ;;',
    '    esac',
    '  fi',
    'done',
  ].join('\n');

  const probeRes = await execRemoteSSH(server, probeScript, {
    zeroImpact: true,
    timeoutMs: 20000,
  });

  if (probeRes.code !== 0 || !probeRes.stdout.trim()) {
    return { patchedFiles: [] };
  }

  const allowedSet = new Set<string>(CANDIDATE_CONFIG_FILES);
  const foundCandidates = probeRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => allowedSet.has(s));

  for (const relFile of foundCandidates) {
    const readScript = buildSafeConfigReadScript(
      cleanTargetWebroot,
      relFile,
      effectiveSiteUser
    );
    const readRes = await execRemoteSSH(server, readScript, {
      zeroImpact: true,
      timeoutMs: 20000,
    });
    if (readRes.code !== 0 || !readRes.stdout || readRes.stdout.includes('\0')) {
      continue;
    }

    const updated = applyConfigReplacements(relFile, readRes.stdout, {
      changedDbs,
      sourceWebroot: webrootChanged ? cleanSourceWebroot : undefined,
      targetWebroot: webrootChanged ? cleanTargetWebroot : undefined,
    });

    if (updated !== readRes.stdout) {
      await writeRemoteFileAtomicallyOverSsh(
        server,
        cleanTargetWebroot,
        relFile,
        effectiveSiteUser,
        updated
      );
      patchedFiles.push(relFile);
      onLog(
        `[Config Rewriter] Đã tự động cập nhật cấu hình ${relFile} trên VPS (bản gốc được giữ tại ${relFile}.nas-sync.bak).`
      );
    }
  }

  return { patchedFiles };
}

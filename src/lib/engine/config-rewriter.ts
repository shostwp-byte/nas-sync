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
  registerJobChildProcess,
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

export interface ExtractedWebDbConfig {
  sourceFile: string;
  dbName: string;
  dbUser: string;
  dbPassword?: string;
  dbHost?: string;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripPhpCommentsPreservingStrings(source: string): string {
  return source.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*/g,
    (match) => {
      if (match.startsWith("'") || match.startsWith('"')) {
        return match;
      }
      return ' ';
    }
  );
}

function unescapePhpString(raw: string, quote: string): string {
  if (quote === "'") {
    return raw.replace(/\\(['\\])/g, '$1');
  }
  return raw.replace(/\\(["\\$nrt])/g, (_m, c: string) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    return c;
  });
}

function matchPhpDefine(cleanPhp: string, constNames: string[]): string | undefined {
  for (const name of constNames) {
    const escaped = escapeRegExp(name);
    const re = new RegExp(
      `\\bdefine\\s*\\(\\s*(['"])${escaped}\\1\\s*,\\s*(['"])((?:\\\\.|(?!\\2)[^\\\\])*)\\2\\s*\\)`,
      'i'
    );
    const m = cleanPhp.match(re);
    if (m) {
      return unescapePhpString(m[3], m[2]);
    }
  }
  return undefined;
}

function matchPhpVarAssignment(cleanPhp: string, varNames: string[]): string | undefined {
  for (const name of varNames) {
    const escaped = escapeRegExp(name);
    const re = new RegExp(
      `\\$${escaped}\\s*=\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`,
      'i'
    );
    const m = cleanPhp.match(re);
    if (m) {
      return unescapePhpString(m[2], m[1]);
    }
  }
  return undefined;
}

function matchPhpArrayKey(cleanPhp: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    const re = new RegExp(
      `(['"])${escaped}\\1\\s*=>\\s*(['"])((?:\\\\.|(?!\\2)[^\\\\])*)\\2`,
      'i'
    );
    const m = cleanPhp.match(re);
    if (m) {
      return unescapePhpString(m[3], m[2]);
    }
  }
  return undefined;
}

function matchDotEnvKey(content: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    const re = new RegExp(
      `^[ \\t]*(?:export[ \\t]+)?${escaped}[ \\t]*=[ \\t]*(.*?)[ \\t]*\\r?$`,
      'm'
    );
    const m = content.match(re);
    if (!m) continue;
    const rawVal = m[1].trim();
    if (
      (rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'") && rawVal.length >= 2)
    ) {
      const q = rawVal[0];
      return unescapePhpString(rawVal.slice(1, -1), q);
    }
    return rawVal.replace(/[ \t]+#.*$/, '').trim();
  }
  return undefined;
}

/**
 * Trích xuất thông tin kết nối Database (DB_NAME, DB_USER, DB_PASSWORD, DB_HOST)
 * từ nội dung tệp cấu hình web (wp-config.php, .env, configuration.php, config.php, app/etc/env.php).
 */
export function extractDbCredentialsFromConfigContent(
  fileName: string,
  content: string
): ExtractedWebDbConfig | null {
  if (!content || content.includes('\0')) return null;
  const normRel = fileName.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.posix.basename(normRel);

  let dbName: string | undefined;
  let dbUser: string | undefined;
  let dbPassword: string | undefined;
  let dbHost: string | undefined;

  if (baseName === 'wp-config.php') {
    const cleanPhp = stripPhpCommentsPreservingStrings(content);
    dbName = matchPhpDefine(cleanPhp, ['DB_NAME']);
    dbUser = matchPhpDefine(cleanPhp, ['DB_USER']);
    dbPassword = matchPhpDefine(cleanPhp, ['DB_PASSWORD']);
    dbHost = matchPhpDefine(cleanPhp, ['DB_HOST']);
  } else if (baseName === '.env') {
    dbName = matchDotEnvKey(content, ['DB_DATABASE', 'DB_NAME']);
    dbUser = matchDotEnvKey(content, ['DB_USERNAME', 'DB_USER']);
    dbPassword = matchDotEnvKey(content, ['DB_PASSWORD', 'DB_PASS']);
    dbHost = matchDotEnvKey(content, ['DB_HOST', 'DB_HOSTNAME']);
  } else if (baseName === 'configuration.php') {
    const cleanPhp = stripPhpCommentsPreservingStrings(content);
    dbName = matchPhpVarAssignment(cleanPhp, ['db']);
    dbUser = matchPhpVarAssignment(cleanPhp, ['user']);
    dbPassword = matchPhpVarAssignment(cleanPhp, ['password']);
    dbHost = matchPhpVarAssignment(cleanPhp, ['host']);
  } else if (baseName === 'config.php' || normRel === 'app/etc/env.php') {
    const cleanPhp = stripPhpCommentsPreservingStrings(content);
    dbName =
      matchPhpDefine(cleanPhp, ['DB_DATABASE', 'DB_NAME']) ??
      matchPhpArrayKey(cleanPhp, ['dbname', 'database', 'db_name']) ??
      matchPhpVarAssignment(cleanPhp, ['dbname', 'db_name', 'database']);
    dbUser =
      matchPhpDefine(cleanPhp, ['DB_USERNAME', 'DB_USER']) ??
      matchPhpArrayKey(cleanPhp, ['username', 'user', 'db_user']) ??
      matchPhpVarAssignment(cleanPhp, ['dbuser', 'db_user', 'username']);
    dbPassword =
      matchPhpDefine(cleanPhp, ['DB_PASSWORD', 'DB_PASS']) ??
      matchPhpArrayKey(cleanPhp, ['password', 'pass', 'db_password']) ??
      matchPhpVarAssignment(cleanPhp, ['dbpass', 'db_password', 'password']);
    dbHost =
      matchPhpDefine(cleanPhp, ['DB_HOSTNAME', 'DB_HOST', 'DB_SERVER']) ??
      matchPhpArrayKey(cleanPhp, ['host', 'hostname', 'db_host']) ??
      matchPhpVarAssignment(cleanPhp, ['dbhost', 'db_host', 'host']);
  }

  const cleanDbName = (dbName || '').trim();
  if (!cleanDbName || !isSafeDbName(cleanDbName)) {
    return null;
  }

  return {
    sourceFile: normRel,
    dbName: cleanDbName,
    dbUser: (dbUser || '').trim(),
    dbPassword,
    dbHost: (dbHost || 'localhost').trim() || 'localhost',
  };
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
  // S2 Fix: Khi kết nối SSH dưới quyền root, BẮT BUỘC phải hạ quyền xuống siteUser hợp lệ != root.
  // Tuyệt đối không có nhánh fallback chạy INNER_SCRIPT dưới quyền root nếu user đích không tồn tại!
  return [
    `SITE_USER=${quotedUser}`,
    `INNER_SCRIPT=${quotedInner}`,
    'if [ "$(id -u)" = "0" ]; then',
    '  if [ "$SITE_USER" = "root" ] || ! id -u "$SITE_USER" >/dev/null 2>&1; then',
    '    echo "ERR_UNSAFE_SITE_USER" >&2',
    '    exit 93',
    '  fi',
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
 * S2 Security Fix: Kiểm tra từng thành phần đường dẫn không chứa symlink, bắt buộc hạ quyền xuống user của site,
 * từ chối nếu đích là thư mục, và dùng `mktemp` (O_CREAT|O_EXCL) kết hợp `mv -fT` (rename nguyên tử không đi vào thư mục đích)
 * để chặn tuyệt đối kịch bản tạo sẵn symlink hoặc thư mục `.nas-sync.bak`.
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
    '[ -f "$F" ] && [ ! -L "$F" ] && [ ! -d "$F" ]',
    'D_DIR=$(dirname -- "$F")',
    '[ -d "$D_DIR" ] && [ ! -L "$D_DIR" ]',
    'REAL_F=$(realpath -e -- "$F")',
    'case "$REAL_F" in "$REAL_ROOT"/*) ;; *) exit 92 ;; esac',
    '[ ! -d "$REAL_F" ] || exit 92',
    '[ ! -d "$REAL_F.nas-sync.bak" ] || exit 92',
    'BAK_TMP=$(mktemp "$D_DIR/.nas-sync-bak.XXXXXX")',
    'TMP_NEW=$(mktemp "$D_DIR/.nas-sync-tmp.XXXXXX")',
    'trap \'rm -f -- "$BAK_TMP" "$TMP_NEW"\' EXIT',
    'cp -P -- "$REAL_F" "$BAK_TMP"',
    'chmod 600 -- "$BAK_TMP"',
    'cat > "$TMP_NEW"',
    'chmod --reference="$REAL_F" "$TMP_NEW" 2>/dev/null || chmod 640 "$TMP_NEW"',
    'rm -f -- "$REAL_F.nas-sync.bak"',
    '[ ! -d "$REAL_F.nas-sync.bak" ] || exit 92',
    'mv -fT -- "$BAK_TMP" "$REAL_F.nas-sync.bak" 2>/dev/null || { [ ! -d "$REAL_F.nas-sync.bak" ] && mv -f -- "$BAK_TMP" "$REAL_F.nas-sync.bak"; }',
    '[ ! -d "$REAL_F" ] || exit 92',
    'mv -fT -- "$TMP_NEW" "$REAL_F" 2>/dev/null || { [ ! -d "$REAL_F" ] && mv -f -- "$TMP_NEW" "$REAL_F"; }',
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
    changedDbUsers?: Array<[string, string]>;
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

  for (const [oldUser, newUser] of options.changedDbUsers || []) {
    if (!oldUser || !newUser || oldUser === newUser) continue;
    const escapedOldUser = escapeRegExp(oldUser);

    if (baseName === 'wp-config.php') {
      const wpUserRe = new RegExp(
        `define\\(\\s*(['"])DB_USER\\1\\s*,\\s*(['"])${escapedOldUser}\\2\\s*\\)`,
        'g'
      );
      next = next.replace(
        wpUserRe,
        (_m, q1: string, q2: string) =>
          `define(${q1}DB_USER${q1}, ${q2}${newUser}${q2})`
      );
    } else if (baseName === '.env') {
      const envUserRe = new RegExp(
        `^([ \\t]*(?:export[ \\t]+)?DB_USERNAME[ \\t]*=[ \\t]*["']?)${escapedOldUser}(["']?[ \\t]*\\r?)$`,
        'gm'
      );
      next = next.replace(
        envUserRe,
        (_m, pre: string, post: string) => `${pre}${newUser}${post}`
      );
    } else if (baseName === 'configuration.php') {
      const joomlaUserRe = new RegExp(
        `(\\$user\\s*=\\s*(['"]))${escapedOldUser}(\\2)`,
        'g'
      );
      next = next.replace(
        joomlaUserRe,
        (_m, pre: string, _q: string, post: string) => `${pre}${newUser}${post}`
      );
    } else if (baseName === 'config.php' || normRel === 'app/etc/env.php') {
      const defineUserRe = new RegExp(
        `define\\(\\s*(['"])(DB_USERNAME|DB_USER)\\1\\s*,\\s*(['"])${escapedOldUser}\\3\\s*\\)`,
        'gi'
      );
      next = next.replace(
        defineUserRe,
        (_m, q1: string, key: string, q2: string) =>
          `define(${q1}${key}${q1}, ${q2}${newUser}${q2})`
      );

      const arrayUserRe = new RegExp(
        `((['"])(?:username|user|db_user)\\2\\s*=>\\s*(['"]))${escapedOldUser}(\\3)`,
        'gi'
      );
      next = next.replace(
        arrayUserRe,
        (_m, pre: string, _kq: string, _vq: string, post: string) =>
          `${pre}${newUser}${post}`
      );

      const varUserRe = new RegExp(
        `(\\$(?:dbuser|db_user|username)\\s*=\\s*(['"]))${escapedOldUser}(\\2)`,
        'gi'
      );
      next = next.replace(
        varUserRe,
        (_m, pre: string, _q: string, post: string) => `${pre}${newUser}${post}`
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
  timeoutMs = 20000,
  jobId?: number
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
    const unregisterChild =
      jobId !== undefined ? registerJobChildProcess(jobId, child) : null;

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        unregisterChild?.();
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
      unregisterChild?.();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      unregisterChild?.();
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

/**
 * Đọc trực tiếp các tệp cấu hình web (wp-config.php, .env, configuration.php, config.php, app/etc/env.php)
 * trong thư mục webroot cục bộ (trên NAS) để trích xuất DB_NAME, DB_USER, DB_PASSWORD, DB_HOST.
 */
export function extractDbCredentialsFromDirectory(
  webrootDir: string
): ExtractedWebDbConfig[] {
  if (!webrootDir || !fs.existsSync(webrootDir)) {
    return [];
  }
  const rootStat = fs.lstatSync(webrootDir, { throwIfNoEntry: false });
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return [];
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(webrootDir);
  } catch {
    return [];
  }

  const results: ExtractedWebDbConfig[] = [];
  for (const relFile of CANDIDATE_CONFIG_FILES) {
    const fullPath = path.resolve(webrootDir, relFile);
    if (!fs.existsSync(fullPath)) continue;
    if (hasAnySymlinkAlongRelativePath(webrootDir, relFile)) continue;

    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (
      !lst.isFile() ||
      lst.isSymbolicLink() ||
      lst.size === 0 ||
      lst.size > MAX_CONFIG_FILE_BYTES
    ) {
      continue;
    }

    let realFile: string;
    try {
      realFile = fs.realpathSync(fullPath);
    } catch {
      continue;
    }
    if (!realFile.startsWith(realRoot + path.sep)) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = extractDbCredentialsFromConfigContent(relFile, content);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Fallback đọc tệp cấu hình web từ máy chủ đích qua SSH (dùng khi khôi phục DB_ONLY mà bản sao lưu cục bộ không có public_html).
 */
export async function extractDbCredentialsFromRemoteWebrootOverSsh(params: {
  server: ServerRecord;
  targetUser: string;
  targetDomain: string;
  targetWebroot: string;
  jobId?: number;
}): Promise<ExtractedWebDbConfig[]> {
  const { server, targetUser, targetDomain } = params;
  const cleanTargetWebroot = (params.targetWebroot || '').trim().replace(/\/+$/, '');
  if (
    server.is_mock ||
    !isSafeWebroot(cleanTargetWebroot) ||
    !isSafeSystemUser(targetUser) ||
    !isSafeDomain(targetDomain)
  ) {
    return [];
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
    jobId: params.jobId,
  });
  if (probeRes.code !== 0 || !probeRes.stdout.trim()) {
    return [];
  }

  const allowedSet = new Set<string>(CANDIDATE_CONFIG_FILES);
  const foundCandidates = probeRes.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => allowedSet.has(s));

  const results: ExtractedWebDbConfig[] = [];
  for (const relFile of foundCandidates) {
    const readScript = buildSafeConfigReadScript(
      cleanTargetWebroot,
      relFile,
      effectiveSiteUser
    );
    const readRes = await execRemoteSSH(server, readScript, {
      zeroImpact: true,
      timeoutMs: 20000,
      jobId: params.jobId,
    });
    if (readRes.code !== 0 || !readRes.stdout || readRes.stdout.includes('\0')) {
      continue;
    }
    const parsed = extractDbCredentialsFromConfigContent(relFile, readRes.stdout);
    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

export async function patchRestoredWebConfigOverSsh(params: {
  server: ServerRecord;
  targetUser: string;
  targetDomain: string;
  targetWebroot: string;
  sourceWebroot: string;
  dbRenameMap: Record<string, string>;
  dbUserRenameMap?: Record<string, string>;
  isMock: boolean;
  mockWebrootDir?: string;
  jobId?: number;
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

  const changedDbUsers: Array<[string, string]> = [];
  for (const [rawOldU, rawNewU] of Object.entries(params.dbUserRenameMap || {})) {
    const oldUser = rawOldU.trim();
    const newUser = String(rawNewU || '').trim();
    if (!oldUser || !newUser || oldUser === newUser) continue;
    if (!isSafeDbName(oldUser) || !isSafeDbName(newUser)) continue;
    changedDbUsers.push([oldUser, newUser]);
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

  if (changedDbs.length === 0 && changedDbUsers.length === 0 && !webrootChanged) {
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
        changedDbUsers,
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
    jobId: params.jobId,
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
      jobId: params.jobId,
    });
    if (readRes.code !== 0 || !readRes.stdout || readRes.stdout.includes('\0')) {
      continue;
    }

    const updated = applyConfigReplacements(relFile, readRes.stdout, {
      changedDbs,
      changedDbUsers,
      sourceWebroot: webrootChanged ? cleanSourceWebroot : undefined,
      targetWebroot: webrootChanged ? cleanTargetWebroot : undefined,
    });

    if (updated !== readRes.stdout) {
      await writeRemoteFileAtomicallyOverSsh(
        server,
        cleanTargetWebroot,
        relFile,
        effectiveSiteUser,
        updated,
        20000,
        params.jobId
      );
      patchedFiles.push(relFile);
      onLog(
        `[Config Rewriter] Đã tự động cập nhật cấu hình ${relFile} trên VPS (bản gốc được giữ tại ${relFile}.nas-sync.bak).`
      );
    }
  }

  return { patchedFiles };
}

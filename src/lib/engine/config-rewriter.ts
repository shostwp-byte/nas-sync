import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/db';
import { buildSshBaseArgs, execRemoteSSH, shellSingleQuote, wrapZeroImpact } from '@/lib/ssh';
import type { ServerRecord } from '@/types';
import {
  isSafeDbName,
  isSafeDomain,
  isSafeSystemUser,
  isSafeWebroot,
} from './safe-names';

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
      // Hằng số define('DB_DATABASE' | 'DB_NAME', 'oldDb')
      const defineDbRe = new RegExp(
        `define\\(\\s*(['"])(DB_DATABASE|DB_NAME)\\1\\s*,\\s*(['"])${escapedOld}\\3\\s*\\)`,
        'gi'
      );
      next = next.replace(
        defineDbRe,
        (_m, q1: string, key: string, q2: string) =>
          `define(${q1}${key}${q1}, ${q2}${newDb}${q2})`
      );

      // Mảng cấu hình PHP: 'dbname' => 'oldDb', 'database' => 'oldDb', 'db_name' => 'oldDb'
      const arrayDbRe = new RegExp(
        `((['"])(?:dbname|database|db_name)\\2\\s*=>\\s*(['"]))${escapedOld}(\\3)`,
        'gi'
      );
      next = next.replace(
        arrayDbRe,
        (_m, pre: string, _kq: string, _vq: string, post: string) =>
          `${pre}${newDb}${post}`
      );

      // Biến PHP: $dbname = 'oldDb' | $db_name = 'oldDb' | $database = 'oldDb'
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
  content: string,
  timeoutMs = 20000
): Promise<void> {
  const sshUser = (server.ssh_user || 'root').trim();
  const ipAddr = (server.ip_address || '').trim();
  const remoteFile = `${cleanTargetWebroot}/${relFile}`;

  const innerScript = [
    'set -e',
    `WEBROOT=${shellSingleQuote(cleanTargetWebroot)}`,
    `F=${shellSingleQuote(remoteFile)}`,
    'REAL_ROOT=$(realpath -e -- "$WEBROOT")',
    '[ -f "$F" ] && [ ! -L "$F" ]',
    'D_DIR=$(dirname -- "$F")',
    '[ ! -L "$D_DIR" ]',
    'REAL_F=$(realpath -e -- "$F")',
    'case "$REAL_F" in "$REAL_ROOT"/*) ;; *) exit 1 ;; esac',
    'cp -p -- "$F" "$F.nas-sync.bak"',
    'chmod 600 -- "$F.nas-sync.bak"',
    'TMP="$F.nas-sync.tmp.$$"',
    'cat > "$TMP"',
    'chmod --reference="$F" "$TMP" 2>/dev/null || chmod 640 "$TMP"',
    'chown --reference="$F" "$TMP" 2>/dev/null || true',
    'mv -f -- "$TMP" "$F"',
  ].join('\n');

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
    });

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
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

    const realRoot = fs.realpathSync(rootDir);
    for (const relFile of CANDIDATE_CONFIG_FILES) {
      const fullPath = path.resolve(rootDir, relFile);
      if (!fs.existsSync(fullPath)) continue;

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
        const bakPath = `${fullPath}.nas-sync.bak`;
        const tmpPath = `${fullPath}.nas-sync.tmp`;
        fs.copyFileSync(fullPath, bakPath);
        fs.writeFileSync(tmpPath, updated, 'utf8');
        fs.renameSync(tmpPath, fullPath);
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

  const quotedCandidates = CANDIDATE_CONFIG_FILES.map((c) =>
    shellSingleQuote(c)
  ).join(' ');
  const probeScript = [
    `WEBROOT=${shellSingleQuote(cleanTargetWebroot)}`,
    'REAL_ROOT=$(realpath -e -- "$WEBROOT" 2>/dev/null) || exit 0',
    `for REL in ${quotedCandidates}; do`,
    '  F="$WEBROOT/$REL"',
    '  if [ -f "$F" ] && [ ! -L "$F" ]; then',
    '    D_DIR=$(dirname -- "$F")',
    '    if [ ! -L "$D_DIR" ]; then',
    '      REAL_F=$(realpath -e -- "$F" 2>/dev/null || true)',
    '      case "$REAL_F" in',
    '        "$REAL_ROOT"/*)',
    '          SZ=$(wc -c < "$F" 2>/dev/null | tr -d "[:space:]")',
    `          if [ -n "$SZ" ] && [ "$SZ" -gt 0 ] && [ "$SZ" -le ${MAX_CONFIG_FILE_BYTES} ]; then`,
    '            printf "%s\\n" "$REL"',
    '          fi',
    '          ;;',
    '      esac',
    '    fi',
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
    const remoteFile = `${cleanTargetWebroot}/${relFile}`;
    const readRes = await execRemoteSSH(
      server,
      `cat -- ${shellSingleQuote(remoteFile)}`,
      { zeroImpact: true, timeoutMs: 20000 }
    );
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

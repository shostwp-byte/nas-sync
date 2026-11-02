import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDataDir, getDb, getDbFilePath, getSetting, setSettings } from './db';
import { emitSystemUpdateProgress } from './events';
import { createSystemAlert } from './notifications';
import type { SystemUpdateInfo, UpdateProgressEvent } from '@/types';

export const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER || 'shostwp-byte';
export const GITHUB_REPO = process.env.GITHUB_REPO_NAME || 'nas-sync';
export const GITHUB_BRANCH = process.env.GITHUB_REPO_BRANCH || 'main';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

const PREBUILT_ARCHIVE_NAME = 'nas-sync-prebuilt.tar.gz';
const PREBUILT_SHA256_NAME = 'nas-sync-prebuilt.tar.gz.sha256';

const SYNC_TARGETS = [
  'src',
  '.next',
  'server.ts',
  'package.json',
  'package-lock.json',
  'next.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'tsconfig.json',
  'BUILD_INFO.json',
] as const;

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
  url?: string;
  size?: number;
}

interface GitHubReleaseResponse {
  tag_name?: string;
  name?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

declare global {
  // eslint-disable-next-line no-var
  var __nasSyncUpdating: boolean | undefined;
}

export function compareSemver(a: string, b: string): number {
  const clean = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => Number(n) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export function getLocalBuildMetadata(): {
  version: string;
  commit: string | null;
} {
  const cwd = process.cwd();
  let version = '1.1.0';
  let commit: string | null = null;

  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        version?: string;
      };
      if (pkg.version) version = pkg.version;
    }
  } catch {
    // Fallback default version
  }

  try {
    const buildInfoPath = path.join(cwd, 'BUILD_INFO.json');
    if (fs.existsSync(buildInfoPath)) {
      const info = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as {
        commit?: string;
      };
      if (info.commit) commit = info.commit;
    }
  } catch {
    // Ignore
  }

  if (!commit) {
    const savedSha = getSetting('installed_commit_sha', '');
    if (savedSha) commit = savedSha;
  }

  if (!commit) {
    try {
      const gitHeadPath = path.join(cwd, '.git', 'HEAD');
      if (fs.existsSync(gitHeadPath)) {
        const headRaw = fs.readFileSync(gitHeadPath, 'utf8').trim();
        if (headRaw.startsWith('ref: ')) {
          const refRel = headRaw.slice(5).trim();
          const refPath = path.join(cwd, '.git', refRel);
          if (fs.existsSync(refPath)) {
            commit = fs.readFileSync(refPath, 'utf8').trim();
          }
        } else if (/^[0-9a-f]{40}$/i.test(headRaw)) {
          commit = headRaw;
        }
      }
    } catch {
      // Ignore
    }
  }

  return { version, commit };
}

export function getRollbackMetadata(): {
  canRollback: boolean;
  rollbackVersion: string | null;
  rollbackUpdatedAt: string | null;
} {
  const previousPersistDir = path.join(getDataDir(), 'live_release', 'previous');
  const pkgPath = path.join(previousPersistDir, 'package.json');
  const nextDir = path.join(previousPersistDir, '.next');

  if (!fs.existsSync(pkgPath) || !fs.existsSync(nextDir)) {
    return {
      canRollback: false,
      rollbackVersion: null,
      rollbackUpdatedAt: null,
    };
  }

  let rollbackVersion: string | null = null;
  let rollbackUpdatedAt: string | null = null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      version?: string;
    };
    if (pkg.version) {
      rollbackVersion = pkg.version.replace(/^v/i, '');
    }
  } catch {
    // Ignore
  }

  try {
    const infoPath = path.join(previousPersistDir, 'BUILD_INFO.json');
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as {
        version?: string;
        updatedAt?: string;
        builtAt?: string;
      };
      if (info.version) {
        rollbackVersion = info.version.replace(/^v/i, '');
      }
      rollbackUpdatedAt = info.updatedAt || info.builtAt || null;
    }
  } catch {
    // Ignore
  }

  if (!rollbackUpdatedAt) {
    try {
      rollbackUpdatedAt = fs.statSync(pkgPath).mtime.toISOString();
    } catch {
      rollbackUpdatedAt = null;
    }
  }

  return {
    canRollback: Boolean(rollbackVersion),
    rollbackVersion,
    rollbackUpdatedAt,
  };
}

export function getActiveBlockingReason(): {
  canUpdateNow: boolean;
  blockingReason: string | null;
} {
  if (globalThis.__nasSyncUpdating) {
    return {
      canUpdateNow: false,
      blockingReason:
        'Một tiến trình cập nhật / khôi phục phiên bản khác đang chạy. Vui lòng đợi hoàn tất.',
    };
  }

  const activeJobs = Number(
    getDb()
      .prepare(
        `SELECT COUNT(*) AS cnt FROM backup_jobs WHERE status IN ('RUNNING', 'RESUMING', 'VERIFYING')`
      )
      .get()?.cnt || 0
  );

  if (activeJobs > 0) {
    return {
      canUpdateNow: false,
      blockingReason: `Đang có ${activeJobs} tiến trình Sao lưu / Khôi phục đang chạy. Vui lòng đợi hoàn tất trước khi cập nhật để bảo toàn dữ liệu.`,
    };
  }

  return { canUpdateNow: true, blockingReason: null };
}

function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nas-sync-self-updater/1.3',
  };
  const token =
    process.env.GITHUB_TOKEN || getSetting('github_token', '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function findPrebuiltAssets(assets?: GitHubReleaseAsset[]): {
  tarAsset: GitHubReleaseAsset;
  shaAsset: GitHubReleaseAsset;
} | null {
  if (!Array.isArray(assets)) return null;
  const tarAsset = assets.find(
    (a) => a?.name === PREBUILT_ARCHIVE_NAME && (a.browser_download_url || a.url)
  );
  const shaAsset = assets.find(
    (a) => a?.name === PREBUILT_SHA256_NAME && (a.browser_download_url || a.url)
  );
  if (!tarAsset || !shaAsset) return null;
  return { tarAsset, shaAsset };
}

async function fetchReleaseAssetResponse(
  asset: GitHubReleaseAsset,
  timeoutMs = 120000
): Promise<Response> {
  const token =
    process.env.GITHUB_TOKEN || getSetting('github_token', '').trim();

  if (asset.browser_download_url) {
    const directHeaders: Record<string, string> = {
      'User-Agent': 'nas-sync-self-updater/1.3',
    };
    if (token) {
      directHeaders.Authorization = `Bearer ${token}`;
    }
    const resp = await fetch(asset.browser_download_url, {
      headers: directHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (resp.ok) {
      return resp;
    }
  }

  if (asset.url) {
    const apiHeaders: Record<string, string> = {
      ...buildGitHubHeaders(),
      Accept: 'application/octet-stream',
    };
    const resp = await fetch(asset.url, {
      headers: apiHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (resp.ok) {
      return resp;
    }
    throw new Error(
      `Không thể tải tệp phát hành ${asset.name || ''} (${resp.status} ${resp.statusText}).`
    );
  }

  throw new Error(
    `Không tìm thấy đường dẫn tải xuống hợp lệ cho tệp ${asset.name || ''}.`
  );
}

export async function checkGitHubUpdate(): Promise<SystemUpdateInfo> {
  const local = getLocalBuildMetadata();
  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  const rollbackMeta = getRollbackMetadata();
  const headers = buildGitHubHeaders();

  let latestVersion = local.version;
  let latestCommit: string | null = local.commit;
  let latestPublishedAt: string | null = null;
  let releaseTitle: string | null = null;
  let changelog = '';
  let prebuiltAvailable = false;

  const [releaseRes, commitRes, rawPkgRes] = await Promise.allSettled([
    fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' }
    ),
    fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
      { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' }
    ),
    fetch(
      `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/package.json`,
      { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' }
    ),
  ]);

  if (rawPkgRes.status === 'fulfilled' && rawPkgRes.value.ok) {
    try {
      const remotePkg = (await rawPkgRes.value.json()) as { version?: string };
      if (remotePkg.version) {
        latestVersion = remotePkg.version.replace(/^v/i, '');
      }
    } catch {
      // Ignore parse error
    }
  }

  if (commitRes.status === 'fulfilled' && commitRes.value.ok) {
    try {
      const commitJson = (await commitRes.value.json()) as {
        sha?: string;
        commit?: {
          message?: string;
          committer?: { date?: string };
        };
      };
      if (commitJson.sha) {
        latestCommit = commitJson.sha;
      }
      if (commitJson.commit?.committer?.date) {
        latestPublishedAt = commitJson.commit.committer.date;
      }
      if (commitJson.commit?.message) {
        changelog = commitJson.commit.message;
      }
    } catch {
      // Ignore
    }
  }

  if (releaseRes.status === 'fulfilled' && releaseRes.value.ok) {
    try {
      const relJson = (await releaseRes.value.json()) as GitHubReleaseResponse;
      let relVer = '';
      if (relJson.tag_name) {
        relVer = relJson.tag_name.replace(/^v/i, '');
        if (compareSemver(relVer, latestVersion) >= 0) {
          latestVersion = relVer;
        }
      }
      if (relJson.name) releaseTitle = relJson.name;
      if (relJson.published_at) latestPublishedAt = relJson.published_at;
      if (relJson.body) changelog = relJson.body;
      if (
        relVer &&
        compareSemver(relVer, latestVersion) === 0 &&
        findPrebuiltAssets(relJson.assets)
      ) {
        prebuiltAvailable = true;
      }
    } catch {
      // Ignore
    }
  }

  const versionNewer = compareSemver(latestVersion, local.version) > 0;
  const commitNewer =
    Boolean(local.commit) &&
    Boolean(latestCommit) &&
    local.commit !== latestCommit &&
    compareSemver(latestVersion, local.version) >= 0;

  return {
    repoUrl: GITHUB_REPO_URL,
    currentVersion: local.version,
    currentCommit: local.commit ? local.commit.slice(0, 7) : null,
    latestVersion,
    latestCommit: latestCommit ? latestCommit.slice(0, 7) : null,
    latestPublishedAt,
    releaseTitle,
    changelog:
      changelog ||
      'Kho lưu trữ GitHub sẵn sàng đồng bộ phiên bản mới nhất trên nhánh main.',
    hasUpdate: versionNewer || commitNewer,
    updateInProgress: Boolean(globalThis.__nasSyncUpdating),
    canUpdateNow,
    blockingReason,
    prebuiltAvailable,
    canRollback: rollbackMeta.canRollback,
    rollbackVersion: rollbackMeta.rollbackVersion,
    rollbackUpdatedAt: rollbackMeta.rollbackUpdatedAt,
    checkedAt: new Date().toISOString(),
  };
}

function broadcastStep(
  status: UpdateProgressEvent['status'],
  percent: number,
  message: string,
  logLine?: string,
  targetVersion?: string
) {
  const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  emitSystemUpdateProgress({
    status,
    percent,
    message,
    logLine: logLine ? `[${ts}] ${logLine}` : undefined,
    targetVersion,
  });
}

function runStreamingCommand(
  cmd: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  timeoutMs = 15 * 60 * 1000
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
      }, 5000);
      reject(
        new Error(
          `Lệnh cập nhật (${cmd}) vượt quá thời gian chờ tối đa (${Math.round(
            timeoutMs / 60000
          )} phút).`
        )
      );
    }, timeoutMs);

    const cleanupTimers = () => {
      clearTimeout(timeoutHandle);
      if (killTimer) clearTimeout(killTimer);
    };

    const handleChunk = (buf: Buffer) => {
      const lines = buf
        .toString('utf8')
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const l of lines) onLine(l);
    };

    child.stdout.on('data', handleChunk);
    child.stderr.on('data', handleChunk);
    child.on('error', (err) => {
      cleanupTimers();
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('close', (code) => {
      cleanupTimers();
      if (settled) return;
      settled = true;
      resolve(code ?? 1);
    });
  });
}

function backupSqliteBeforeUpdate(): string {
  const dbFile = getDbFilePath();
  const backupsDir = path.join(getDataDir(), 'db_backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `nas-sync-pre-update-${stamp}.db`);
  if (fs.existsSync(dbFile)) {
    try {
      fs.rmSync(dest, { force: true });
      getDb().prepare('VACUUM INTO ?').run(dest);
    } catch {
      fs.copyFileSync(dbFile, dest);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbFile}${suffix}`;
        if (fs.existsSync(sidecar)) {
          fs.copyFileSync(sidecar, `${dest}${suffix}`);
        }
      }
    }
  }

  // Giữ tối đa 5 bản sao lưu CSDL gần nhất
  const all = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of all.slice(5)) {
    const oldBase = path.join(backupsDir, old);
    fs.rmSync(oldBase, { force: true });
    fs.rmSync(`${oldBase}-wal`, { force: true });
    fs.rmSync(`${oldBase}-shm`, { force: true });
  }
  return dest;
}

function haveDependenciesChanged(oldPkgPath: string, newPkgPath: string): boolean {
  try {
    const oldPkg = JSON.parse(fs.readFileSync(oldPkgPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')) as Record<
      string,
      unknown
    >;
    return (
      JSON.stringify(oldPkg.dependencies || {}) !==
        JSON.stringify(newPkg.dependencies || {}) ||
      JSON.stringify(oldPkg.devDependencies || {}) !==
        JSON.stringify(newPkg.devDependencies || {})
    );
  } catch {
    return true;
  }
}

async function computeFileSha256Hex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function syncReleaseDirToAppRoot(sourcePersistDir: string, appRoot: string) {
  for (const item of SYNC_TARGETS) {
    const srcItem = path.join(sourcePersistDir, item);
    const dstItem = path.join(appRoot, item);
    if (!fs.existsSync(srcItem)) continue;
    const st = fs.lstatSync(srcItem);
    if (st.isDirectory()) {
      fs.rmSync(dstItem, { recursive: true, force: true });
      fs.cpSync(srcItem, dstItem, { recursive: true, force: true });
    } else {
      fs.copyFileSync(srcItem, dstItem);
    }
  }
}

/**
 * Lưu trữ bản đang chạy vào `live_release/previous` trước khi ghi đè `live_release/current`,
 * kể cả lần nâng cấp đầu tiên từ Docker Image gốc (snapshot từ appRoot, bỏ qua .next/cache).
 */
function preservePreviousReleaseSnapshot(
  appRoot: string,
  currentPersistDir: string,
  previousPersistDir: string
) {
  const currentHasBuild =
    fs.existsSync(path.join(currentPersistDir, 'package.json')) &&
    fs.existsSync(path.join(currentPersistDir, '.next'));

  if (currentHasBuild) {
    const oldPrevBackup = `${previousPersistDir}.old`;
    fs.rmSync(oldPrevBackup, { recursive: true, force: true });
    if (fs.existsSync(previousPersistDir)) {
      fs.renameSync(previousPersistDir, oldPrevBackup);
    }
    fs.renameSync(currentPersistDir, previousPersistDir);
    fs.rmSync(oldPrevBackup, { recursive: true, force: true });
    return;
  }

  const appRootHasBuild =
    fs.existsSync(path.join(appRoot, 'package.json')) &&
    fs.existsSync(path.join(appRoot, '.next'));

  if (!appRootHasBuild) {
    return;
  }

  const tmpPrevDir = `${previousPersistDir}.tmp`;
  fs.rmSync(tmpPrevDir, { recursive: true, force: true });
  fs.mkdirSync(tmpPrevDir, { recursive: true });

  const nextCachePrefix = path.resolve(appRoot, '.next', 'cache');
  for (const item of SYNC_TARGETS) {
    const srcItem = path.join(appRoot, item);
    const dstItem = path.join(tmpPrevDir, item);
    if (!fs.existsSync(srcItem)) continue;
    const st = fs.lstatSync(srcItem);
    if (st.isDirectory()) {
      fs.cpSync(srcItem, dstItem, {
        recursive: true,
        force: true,
        filter: (src) => {
          const resolved = path.resolve(src);
          return (
            resolved !== nextCachePrefix &&
            !resolved.startsWith(nextCachePrefix + path.sep)
          );
        },
      });
    } else {
      fs.copyFileSync(srcItem, dstItem);
    }
  }

  const tmpBuildInfoPath = path.join(tmpPrevDir, 'BUILD_INFO.json');
  if (!fs.existsSync(tmpBuildInfoPath)) {
    const localMeta = getLocalBuildMetadata();
    fs.writeFileSync(
      tmpBuildInfoPath,
      JSON.stringify(
        {
          name: 'nas-sync',
          version: localMeta.version,
          commit: localMeta.commit,
          updatedAt: new Date().toISOString(),
          source: GITHUB_REPO_URL,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  const oldPrevBackup = `${previousPersistDir}.old`;
  fs.rmSync(oldPrevBackup, { recursive: true, force: true });
  if (fs.existsSync(previousPersistDir)) {
    fs.renameSync(previousPersistDir, oldPrevBackup);
  }
  fs.renameSync(tmpPrevDir, previousPersistDir);
  fs.rmSync(oldPrevBackup, { recursive: true, force: true });
}

export async function performGitHubUpdate(
  options: {
    force?: boolean;
  } = {}
): Promise<void> {
  if (globalThis.__nasSyncUpdating) {
    throw new Error(
      'Một tiến trình cập nhật khác đang chạy. Vui lòng đợi hoàn tất.'
    );
  }

  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  if (!canUpdateNow) {
    throw new Error(blockingReason || 'Không thể cập nhật ngay lúc này.');
  }

  globalThis.__nasSyncUpdating = true;

  const appRoot = process.cwd();
  const releaseBaseDir = path.join(getDataDir(), 'live_release');
  const stagingDir = path.join(releaseBaseDir, 'staging');
  const currentPersistDir = path.join(releaseBaseDir, 'current');
  const previousPersistDir = path.join(releaseBaseDir, 'previous');
  const tarballPath = path.join(releaseBaseDir, 'latest-main.tar.gz');
  const prebuiltTarPath = path.join(releaseBaseDir, PREBUILT_ARCHIVE_NAME);

  const shouldSyncAppRoot =
    process.platform !== 'win32' ||
    process.env.ALLOW_LOCAL_SELF_OVERWRITE === 'true';

  try {
    broadcastStep(
      'CHECKING',
      5,
      'Đang kiểm tra thông tin bản phát hành từ GitHub...',
      `Kết nối tới ${GITHUB_REPO_URL} (nhánh ${GITHUB_BRANCH})...`
    );

    const checkInfo = await checkGitHubUpdate();
    const targetVer = checkInfo.latestVersion;

    if (!checkInfo.hasUpdate && !options.force) {
      globalThis.__nasSyncUpdating = false;
      broadcastStep(
        'COMPLETED',
        100,
        `Hệ thống đang ở phiên bản mới nhất (v${targetVer}).`,
        'Không có thay đổi mới cần cập nhật.',
        targetVer
      );
      return;
    }

    // 1. Sao lưu CSDL SQLite nguyên tử (VACUUM INTO) trước khi cập nhật
    broadcastStep(
      'DOWNLOADING',
      12,
      'Đang tạo bản sao lưu an toàn CSDL quản trị...',
      'Sao lưu nguyên tử CSDL SQLite (VACUUM INTO) trước khi nâng cấp...'
    );
    const dbBackupFile = backupSqliteBeforeUpdate();

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    let usedPrebuiltFastPath = false;
    let prebuiltCommitSha = '';

    // 2A. Thử luồng Prebuilt Fast-Path (~5 giây, xác thực chữ ký SHA-256, không cần next build trên NAS)
    if (!options.force) {
      let matchedAssets: {
        tarAsset: GitHubReleaseAsset;
        shaAsset: GitHubReleaseAsset;
      } | null = null;

      try {
        const relResp = await fetch(
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
          {
            headers: buildGitHubHeaders(),
            signal: AbortSignal.timeout(10000),
            cache: 'no-store',
          }
        );
        if (relResp.ok) {
          const relJson = (await relResp.json()) as GitHubReleaseResponse;
          const relVer = (relJson.tag_name || '').replace(/^v/i, '');
          if (relVer && compareSemver(relVer, targetVer) === 0) {
            matchedAssets = findPrebuiltAssets(relJson.assets);
          }
        }
      } catch {
        matchedAssets = null;
      }

      if (matchedAssets) {
        broadcastStep(
          'DOWNLOADING',
          20,
          `Phát hiện gói Prebuilt v${targetVer} — Đang tải & kiểm tra chữ ký SHA-256...`,
          `Đã sao lưu CSDL (${path.basename(
            dbBackupFile
          )}). Đang tải ${PREBUILT_ARCHIVE_NAME} kèm checksum SHA-256...`,
          targetVer
        );

        const shaResp = await fetchReleaseAssetResponse(
          matchedAssets.shaAsset,
          30000
        );
        const rawShaText = await shaResp.text();
        const expectedHex = (rawShaText.trim().split(/\s+/)[0] || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(expectedHex)) {
          throw new Error(
            '[SECURITY] Tệp chữ ký SHA-256 trên GitHub Release không đúng định dạng chuẩn 64 ký tự hex.'
          );
        }

        const tarResp = await fetchReleaseAssetResponse(
          matchedAssets.tarAsset,
          120000
        );
        if (!tarResp.body) {
          throw new Error('Luồng tải gói Prebuilt từ GitHub Release bị rỗng.');
        }

        const fileStream = fs.createWriteStream(prebuiltTarPath);
        await pipeline(
          Readable.fromWeb(
            tarResp.body as unknown as import('node:stream/web').ReadableStream
          ),
          fileStream
        );

        const actualHex = (
          await computeFileSha256Hex(prebuiltTarPath)
        ).toLowerCase();
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        const actualBuf = Buffer.from(actualHex, 'hex');
        if (
          expectedBuf.length !== actualBuf.length ||
          !crypto.timingSafeEqual(expectedBuf, actualBuf)
        ) {
          fs.rmSync(prebuiltTarPath, { force: true });
          throw new Error(
            `[SECURITY] Sai lệch mã băm SHA-256 của gói cập nhật Prebuilt (mong đợi ${expectedHex.slice(
              0,
              12
            )}..., nhận được ${actualHex.slice(
              0,
              12
            )}...)! Đã hủy cập nhật ngay lập tức để bảo vệ NAS.`
          );
        }

        broadcastStep(
          'DOWNLOADING',
          42,
          'Chữ ký SHA-256 hợp lệ 100% — Đang giải nén gói Prebuilt...',
          `SHA-256 khớp tuyệt đối (${actualHex.slice(
            0,
            16
          )}...). Giải nén vào vùng Staging...`,
          targetVer
        );

        const untarCode = await runStreamingCommand(
          tarBin,
          ['-xzf', prebuiltTarPath, '--strip-components=1', '-C', stagingDir],
          releaseBaseDir,
          (line) =>
            broadcastStep(
              'DOWNLOADING',
              48,
              'Đang giải nén gói Prebuilt...',
              line,
              targetVer
            )
        );
        fs.rmSync(prebuiltTarPath, { force: true });

        if (
          untarCode !== 0 ||
          !fs.existsSync(path.join(stagingDir, 'package.json')) ||
          !fs.existsSync(path.join(stagingDir, '.next', 'BUILD_ID'))
        ) {
          throw new Error(
            'Gói Prebuilt sau khi giải nén thiếu .next/BUILD_ID hoặc package.json.'
          );
        }

        try {
          const prebuiltInfo = JSON.parse(
            fs.readFileSync(path.join(stagingDir, 'BUILD_INFO.json'), 'utf8')
          ) as { commit?: string };
          if (prebuiltInfo.commit) {
            prebuiltCommitSha = prebuiltInfo.commit;
          }
        } catch {
          // Ignore
        }

        const depsChanged = haveDependenciesChanged(
          path.join(appRoot, 'package.json'),
          path.join(stagingDir, 'package.json')
        );
        const stagingNodeModules = path.join(stagingDir, 'node_modules');
        fs.rmSync(stagingNodeModules, { recursive: true, force: true });

        if (depsChanged) {
          broadcastStep(
            'INSTALLING',
            62,
            'Phát hiện thư viện mới trong package.json — Đang cài đặt cô lập tại Staging...',
            'Chạy npm install --include=dev --ignore-scripts trong vùng Staging...',
            targetVer
          );
          const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
          const npmCode = await runStreamingCommand(
            npmBin,
            [
              'install',
              '--include=dev',
              '--no-audit',
              '--no-fund',
              '--ignore-scripts',
            ],
            stagingDir,
            (line) =>
              broadcastStep(
                'INSTALLING',
                72,
                'Đang cài đặt thư viện mới...',
                line,
                targetVer
              )
          );
          if (npmCode !== 0) {
            throw new Error(
              'Cài đặt gói phụ thuộc npm trong vùng Staging thất bại. Phiên bản đang chạy vẫn an toàn 100%.'
            );
          }
          if (shouldSyncAppRoot && fs.existsSync(stagingNodeModules)) {
            fs.cpSync(stagingNodeModules, path.join(appRoot, 'node_modules'), {
              recursive: true,
              force: true,
            });
          }
          fs.rmSync(stagingNodeModules, { recursive: true, force: true });
        } else {
          broadcastStep(
            'INSTALLING',
            75,
            'Gói Prebuilt tương thích hoàn toàn — Bỏ qua biên dịch next build, kích hoạt siêu tốc...',
            'Không tốn RAM/CPU biên dịch lại giao diện trên NAS (~5 giây).',
            targetVer
          );
        }

        usedPrebuiltFastPath = true;
      }
    }

    // 2B. Fallback: Tải mã nguồn nhánh main & biên dịch cô lập trên NAS
    if (!usedPrebuiltFastPath) {
      broadcastStep(
        'DOWNLOADING',
        18,
        'Đang tải gói mã nguồn mới nhất từ GitHub...',
        `Đã sao lưu CSDL tại ${path.basename(
          dbBackupFile
        )}. Bắt đầu tải tarball mã nguồn...`,
        targetVer
      );

      const tarballUrl = `https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tar.gz/refs/heads/${GITHUB_BRANCH}`;
      const resp = await fetch(tarballUrl, {
        headers: buildGitHubHeaders(),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok || !resp.body) {
        throw new Error(
          `Không thể tải mã nguồn từ GitHub (${resp.status} ${resp.statusText}). Hãy đảm bảo kho ${GITHUB_REPO_URL} đã có nhánh ${GITHUB_BRANCH}.`
        );
      }

      const fileStream = fs.createWriteStream(tarballPath);
      await pipeline(
        Readable.fromWeb(
          resp.body as unknown as import('node:stream/web').ReadableStream
        ),
        fileStream
      );

      broadcastStep(
        'DOWNLOADING',
        32,
        'Đang giải nén gói mã nguồn vào vùng Staging...',
        'Đã tải xong tarball từ GitHub. Đang giải nén...'
      );

      const untarCode = await runStreamingCommand(
        tarBin,
        ['-xzf', tarballPath, '--strip-components=1', '-C', stagingDir],
        releaseBaseDir,
        (line) => broadcastStep('DOWNLOADING', 35, 'Đang giải nén...', line)
      );
      fs.rmSync(tarballPath, { force: true });

      if (
        untarCode !== 0 ||
        !fs.existsSync(path.join(stagingDir, 'package.json'))
      ) {
        throw new Error('Giải nén gói cập nhật từ GitHub thất bại.');
      }

      // Kiểm tra dependencies và chuẩn bị node_modules cô lập hoàn toàn trong stagingDir
      const depsChanged = haveDependenciesChanged(
        path.join(appRoot, 'package.json'),
        path.join(stagingDir, 'package.json')
      );

      const stagingNodeModules = path.join(stagingDir, 'node_modules');
      fs.rmSync(stagingNodeModules, { recursive: true, force: true });

      if (depsChanged) {
        broadcastStep(
          'INSTALLING',
          45,
          'Phát hiện thư viện mới trong package.json — Đang cài đặt cô lập tại Staging...',
          'Chạy npm install --include=dev --ignore-scripts trong vùng Staging...'
        );
        const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const npmCode = await runStreamingCommand(
          npmBin,
          [
            'install',
            '--include=dev',
            '--no-audit',
            '--no-fund',
            '--ignore-scripts',
          ],
          stagingDir,
          (line) =>
            broadcastStep(
              'INSTALLING',
              52,
              'Đang cài đặt thư viện mới...',
              line
            )
        );
        if (npmCode !== 0) {
          throw new Error(
            'Cài đặt gói phụ thuộc npm trong vùng Staging thất bại. Phiên bản đang chạy vẫn an toàn 100%.'
          );
        }
      } else {
        broadcastStep(
          'INSTALLING',
          48,
          'Các gói node_modules không đổi — Tái sử dụng tức thì...',
          'Liên kết node_modules hiện hành sang vùng Staging (0s)...'
        );
        fs.symlinkSync(
          path.join(appRoot, 'node_modules'),
          stagingNodeModules,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
      }

      // Chạy Production Build (next build) trong vùng Staging cô lập
      broadcastStep(
        'BUILDING',
        60,
        'Đang biên dịch Production UI (next build) trong vùng cô lập...',
        'Khởi chạy Next.js Production Build...'
      );

      const stagedNextBin = path.join(
        stagingNodeModules,
        'next',
        'dist',
        'bin',
        'next'
      );
      const fallbackNextBin = path.join(
        appRoot,
        'node_modules',
        'next',
        'dist',
        'bin',
        'next'
      );
      const nextBin = fs.existsSync(stagedNextBin)
        ? stagedNextBin
        : fallbackNextBin;

      const buildCode = await runStreamingCommand(
        process.execPath,
        [nextBin, 'build'],
        stagingDir,
        (line) =>
          broadcastStep(
            'BUILDING',
            75,
            'Đang biên dịch ứng dụng (next build)...',
            line
          )
      );

      if (buildCode !== 0) {
        throw new Error(
          'Biên dịch bản cập nhật mới thất bại. Phiên bản đang chạy được giữ nguyên an toàn 100%.'
        );
      }

      if (depsChanged) {
        if (shouldSyncAppRoot && fs.existsSync(stagingNodeModules)) {
          fs.cpSync(stagingNodeModules, path.join(appRoot, 'node_modules'), {
            recursive: true,
            force: true,
          });
        }
        fs.rmSync(stagingNodeModules, { recursive: true, force: true });
      } else {
        fs.unlinkSync(stagingNodeModules);
      }
    }

    // 3. Ghi BUILD_INFO.json, bảo toàn bản previous cho Rollback 1-Click, rồi kích hoạt sang current
    broadcastStep(
      'INSTALLING',
      90,
      'Đang lưu điểm khôi phục (Rollback) & kích hoạt phiên bản mới...',
      'Bảo toàn bản hiện hành sang live_release/previous và đồng bộ thực thi...',
      targetVer
    );

    let fullCommit = prebuiltCommitSha || checkInfo.latestCommit || '';
    if (!prebuiltCommitSha) {
      try {
        const cRes = await fetch(
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
          { headers: buildGitHubHeaders(), signal: AbortSignal.timeout(8000) }
        );
        if (cRes.ok) {
          const cj = (await cRes.json()) as { sha?: string };
          if (cj.sha) fullCommit = cj.sha;
        }
      } catch {
        // Keep short commit
      }
    }

    const buildInfo = {
      name: 'nas-sync',
      version: targetVer,
      commit: fullCommit || null,
      prebuilt: usedPrebuiltFastPath,
      updatedAt: new Date().toISOString(),
      source: GITHUB_REPO_URL,
    };
    fs.writeFileSync(
      path.join(stagingDir, 'BUILD_INFO.json'),
      JSON.stringify(buildInfo, null, 2),
      'utf8'
    );

    preservePreviousReleaseSnapshot(
      appRoot,
      currentPersistDir,
      previousPersistDir
    );

    fs.rmSync(currentPersistDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, currentPersistDir);

    if (shouldSyncAppRoot) {
      syncReleaseDirToAppRoot(currentPersistDir, appRoot);
    }

    setSettings({
      installed_version: targetVer,
      installed_commit_sha: fullCommit,
      last_github_update_at: new Date().toISOString(),
    });

    await createSystemAlert({
      severity: 'INFO',
      category: 'SYSTEM',
      title: `Cập nhật NAS-Sync v${targetVer} thành công`,
      message: usedPrebuiltFastPath
        ? `Hệ thống đã nâng cấp siêu tốc lên v${targetVer} qua gói Prebuilt đã xác thực chữ ký SHA-256 (có sẵn điểm Rollback 1-Click).`
        : `Hệ thống đã tự động tải và biên dịch bản cập nhật v${targetVer} (${
            fullCommit ? fullCommit.slice(0, 7) : targetVer
          }) từ ${GITHUB_REPO_URL}.`,
    });

    if (process.platform !== 'win32') {
      broadcastStep(
        'RESTARTING',
        100,
        `Cập nhật v${targetVer} hoàn tất! Đang tự khởi động lại dịch vụ NAS-Sync (~3 giây)...`,
        'Tiến trình cập nhật hoàn tất. Khởi động lại container để áp dụng phiên bản mới...',
        targetVer
      );
      setTimeout(() => {
        process.exit(0);
      }, 1500);
    } else {
      globalThis.__nasSyncUpdating = false;
      broadcastStep(
        'COMPLETED',
        100,
        `Đã cập nhật v${targetVer} thành công tại ${currentPersistDir}! (Môi trường Windows Dev: khởi động lại server để nạp bản mới).`,
        'Hoàn tất kiểm tra cập nhật trên Windows.',
        targetVer
      );
    }
  } catch (err) {
    globalThis.__nasSyncUpdating = false;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(tarballPath, { force: true });
    fs.rmSync(prebuiltTarPath, { force: true });
    const msg =
      (err as Error).message || 'Lỗi không xác định khi cập nhật từ GitHub.';
    broadcastStep('FAILED', 0, msg, `❌ Lỗi: ${msg}`);
    throw err;
  }
}

export async function performRollbackRelease(): Promise<{
  restoredVersion: string;
}> {
  if (globalThis.__nasSyncUpdating) {
    throw new Error(
      'Một tiến trình cập nhật / khôi phục phiên bản khác đang chạy. Vui lòng đợi hoàn tất.'
    );
  }

  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  if (!canUpdateNow) {
    throw new Error(
      blockingReason || 'Không thể thực hiện Rollback ngay lúc này.'
    );
  }

  const releaseBaseDir = path.join(getDataDir(), 'live_release');
  const currentPersistDir = path.join(releaseBaseDir, 'current');
  const previousPersistDir = path.join(releaseBaseDir, 'previous');

  const rollbackMeta = getRollbackMetadata();
  if (
    !rollbackMeta.canRollback ||
    !rollbackMeta.rollbackVersion ||
    !fs.existsSync(path.join(previousPersistDir, 'package.json')) ||
    !fs.existsSync(path.join(previousPersistDir, '.next'))
  ) {
    throw new Error(
      'Không tìm thấy bản lưu phiên bản trước hợp lệ để thực hiện Rollback.'
    );
  }

  globalThis.__nasSyncUpdating = true;

  const appRoot = process.cwd();
  const restoredVersion = rollbackMeta.rollbackVersion;
  const shouldSyncAppRoot =
    process.platform !== 'win32' ||
    process.env.ALLOW_LOCAL_SELF_OVERWRITE === 'true';

  try {
    broadcastStep(
      'CHECKING',
      10,
      `Đang chuẩn bị khôi phục hệ thống về phiên bản v${restoredVersion}...`,
      `Kiểm tra bản lưu tại ${previousPersistDir}...`,
      restoredVersion
    );

    const dbBackupFile = backupSqliteBeforeUpdate();
    broadcastStep(
      'INSTALLING',
      25,
      `Đã tạo bản sao lưu CSDL an toàn — Đang kiểm tra thư viện v${restoredVersion}...`,
      `Sao lưu CSDL tại ${path.basename(dbBackupFile)}.`,
      restoredVersion
    );

    const depsChanged = haveDependenciesChanged(
      path.join(appRoot, 'package.json'),
      path.join(previousPersistDir, 'package.json')
    );

    const prevNodeModules = path.join(previousPersistDir, 'node_modules');
    fs.rmSync(prevNodeModules, { recursive: true, force: true });

    if (depsChanged) {
      broadcastStep(
        'INSTALLING',
        45,
        `Phát hiện khác biệt thư viện — Đang đồng bộ lại node_modules cho v${restoredVersion}...`,
        'Chạy npm install --include=dev --ignore-scripts cho bản Rollback...',
        restoredVersion
      );
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmCode = await runStreamingCommand(
        npmBin,
        [
          'install',
          '--include=dev',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
        ],
        previousPersistDir,
        (line) =>
          broadcastStep(
            'INSTALLING',
            60,
            'Đang khôi phục các gói phụ thuộc...',
            line,
            restoredVersion
          )
      );
      if (npmCode !== 0) {
        throw new Error(
          'Khôi phục thư viện npm cho phiên bản trước thất bại. Hệ thống giữ nguyên phiên bản hiện hành.'
        );
      }
      if (shouldSyncAppRoot && fs.existsSync(prevNodeModules)) {
        fs.cpSync(prevNodeModules, path.join(appRoot, 'node_modules'), {
          recursive: true,
          force: true,
        });
      }
      fs.rmSync(prevNodeModules, { recursive: true, force: true });
    }

    let restoredCommit = '';
    try {
      const infoPath = path.join(previousPersistDir, 'BUILD_INFO.json');
      if (fs.existsSync(infoPath)) {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as {
          commit?: string;
        };
        if (info.commit) restoredCommit = info.commit;
      }
    } catch {
      // Ignore
    }

    broadcastStep(
      'INSTALLING',
      85,
      `Đang hoán đổi nguyên tử về bản v${restoredVersion}...`,
      'Khôi phục live_release/previous -> live_release/current...',
      restoredVersion
    );

    const discardedCurrentBackup = `${currentPersistDir}.discarded`;
    fs.rmSync(discardedCurrentBackup, { recursive: true, force: true });
    if (fs.existsSync(currentPersistDir)) {
      fs.renameSync(currentPersistDir, discardedCurrentBackup);
    }
    fs.renameSync(previousPersistDir, currentPersistDir);
    fs.rmSync(discardedCurrentBackup, { recursive: true, force: true });

    if (shouldSyncAppRoot) {
      syncReleaseDirToAppRoot(currentPersistDir, appRoot);
    }

    setSettings({
      installed_version: restoredVersion,
      installed_commit_sha: restoredCommit,
      last_github_update_at: new Date().toISOString(),
    });

    await createSystemAlert({
      severity: 'WARNING',
      category: 'SYSTEM',
      title: `Đã khôi phục (Rollback) hệ thống về v${restoredVersion}`,
      message: `Quản trị viên đã thực hiện Rollback 1-Click thành công về phiên bản ổn định trước đó (v${restoredVersion}).`,
    });

    if (process.platform !== 'win32') {
      broadcastStep(
        'RESTARTING',
        100,
        `Đã khôi phục v${restoredVersion}! Đang tự khởi động lại dịch vụ NAS-Sync (~3 giây)...`,
        'Hoàn tất Rollback. Khởi động lại container...',
        restoredVersion
      );
      setTimeout(() => {
        process.exit(0);
      }, 1500);
    } else {
      globalThis.__nasSyncUpdating = false;
      broadcastStep(
        'COMPLETED',
        100,
        `Đã khôi phục phiên bản v${restoredVersion} thành công tại ${currentPersistDir}!`,
        'Hoàn tất Rollback trên môi trường Windows.',
        restoredVersion
      );
    }

    return { restoredVersion };
  } catch (err) {
    globalThis.__nasSyncUpdating = false;
    const msg =
      (err as Error).message || 'Lỗi không xác định khi Rollback phiên bản.';
    broadcastStep('FAILED', 0, msg, `❌ Lỗi Rollback: ${msg}`);
    throw err;
  }
}

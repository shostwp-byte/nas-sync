import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  getDataDir,
  getDb,
  getDbFilePath,
  getSetting,
  setSettings,
} from './db';
import { emitSystemUpdateProgress } from './events';
import { createSystemAlert } from './notifications';
import { verifyReleaseSignature } from './release-signature';
import type { SystemUpdateInfo, UpdateProgressEvent } from '@/types';

export const GITHUB_OWNER = process.env.GITHUB_REPO_OWNER || 'shostwp-byte';
export const GITHUB_REPO = process.env.GITHUB_REPO_NAME || 'nas-sync';
export const GITHUB_BRANCH = process.env.GITHUB_REPO_BRANCH || 'main';
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

const PREBUILT_ARCHIVE_NAME = 'nas-sync-prebuilt.tar.gz';
const PREBUILT_SHA256_NAME = 'nas-sync-prebuilt.tar.gz.sha256';
const PREBUILT_SIG_NAME = 'nas-sync-prebuilt.tar.gz.sig';

const SYNC_TARGETS = [
  'src',
  'public',
  'scripts',
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

export interface GitHubReleaseAsset {
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
  var __nasSyncUpdating: boolean | undefined;
}

export function isSystemUpdateInProgress(): boolean {
  return Boolean(globalThis.__nasSyncUpdating);
}

export function isUnverifiedDevMainAllowed(): boolean {
  return process.env.ALLOW_UNVERIFIED_MAIN_UPDATE === 'true';
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
  const previousPersistDir = path.join(
    getDataDir(),
    'live_release',
    'previous'
  );
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

  const db = getDb();
  const activeJobs = Number(
    db
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

  // U4 Fix: Không cho phép cập nhật / khởi động lại container khi đang đẩy snapshot lên kho Offsite Cloud
  try {
    const activeOffsite = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM offsite_sync_jobs WHERE status IN ('UPLOADING', 'QUEUED')`
        )
        .get()?.cnt || 0
    );
    if (activeOffsite > 0) {
      return {
        canUpdateNow: false,
        blockingReason: `Đang có ${activeOffsite} tiến trình đẩy bản sao lưu Offsite lên đám mây. Vui lòng đợi hoàn tất trước khi cập nhật để tránh lỗi tệp dở dang.`,
      };
    }
  } catch {
    // Table may not exist in older unit-test fixtures
  }

  return { canUpdateNow: true, blockingReason: null };
}

function buildGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nas-sync-self-updater/1.6',
  };
  const token =
    process.env.GITHUB_TOKEN || getSetting('github_token', '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function findPrebuiltAssets(assets?: GitHubReleaseAsset[]): {
  tarAsset: GitHubReleaseAsset;
  shaAsset: GitHubReleaseAsset;
  sigAsset: GitHubReleaseAsset;
} | null {
  if (!Array.isArray(assets)) return null;
  const tarAsset = assets.find(
    (a) => a?.name === PREBUILT_ARCHIVE_NAME && (a.browser_download_url || a.url)
  );
  const shaAsset = assets.find(
    (a) => a?.name === PREBUILT_SHA256_NAME && (a.browser_download_url || a.url)
  );
  const sigAsset = assets.find(
    (a) => a?.name === PREBUILT_SIG_NAME && (a.browser_download_url || a.url)
  );
  if (!tarAsset || !shaAsset || !sigAsset) return null;
  return { tarAsset, shaAsset, sigAsset };
}

async function fetchReleaseAssetResponse(
  asset: GitHubReleaseAsset,
  timeoutMs = 120000
): Promise<Response> {
  const token =
    process.env.GITHUB_TOKEN || getSetting('github_token', '').trim();

  if (asset.browser_download_url) {
    const directHeaders: Record<string, string> = {
      'User-Agent': 'nas-sync-self-updater/1.6',
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

/**
 * U1 & U2 Security Fix:
 * Mặc định CHỈ kiểm tra bản phát hành chính thức có gắn tag & đính kèm đầy đủ bộ ba chữ ký số
 * (`nas-sync-prebuilt.tar.gz` + `.sha256` + `.sig`).
 * Kênh dev (`main` HEAD chưa ký) bị tắt hoàn toàn trừ khi quản trị viên chủ động cấu hình `ALLOW_UNVERIFIED_MAIN_UPDATE=true`.
 */
export async function checkGitHubUpdate(): Promise<SystemUpdateInfo> {
  const local = getLocalBuildMetadata();
  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  const rollbackMeta = getRollbackMetadata();
  const headers = buildGitHubHeaders();
  const allowDevMain = isUnverifiedDevMainAllowed();

  let latestVersion = local.version;
  let latestCommit: string | null = local.commit;
  let latestPublishedAt: string | null = null;
  let releaseTitle: string | null = null;
  let changelog = '';
  let prebuiltAvailable = false;
  let unsignedReleaseWarning = '';

  const releasePromise = fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { headers, signal: AbortSignal.timeout(10000), cache: 'no-store' }
  );

  if (allowDevMain) {
    const [releaseRes, commitRes, rawPkgRes] = await Promise.allSettled([
      releasePromise,
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
        const relVer = (relJson.tag_name || '').replace(/^v/i, '');
        if (relVer && compareSemver(relVer, latestVersion) >= 0) {
          latestVersion = relVer;
          if (relJson.name) releaseTitle = relJson.name;
          if (relJson.published_at) latestPublishedAt = relJson.published_at;
          if (relJson.body) changelog = relJson.body;
          if (findPrebuiltAssets(relJson.assets)) {
            prebuiltAvailable = true;
          }
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
        '[DEV MODE] Đang bật ALLOW_UNVERIFIED_MAIN_UPDATE=true (kênh nhánh main).',
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

  try {
    const releaseRes = await releasePromise;
    if (releaseRes.ok) {
      const relJson = (await releaseRes.json()) as GitHubReleaseResponse;
      const relVer = (relJson.tag_name || '').replace(/^v/i, '');
      if (relVer && compareSemver(relVer, local.version) >= 0) {
        latestVersion = relVer;
      }
      if (relJson.name) releaseTitle = relJson.name;
      if (relJson.published_at) latestPublishedAt = relJson.published_at;
      if (relJson.body) changelog = relJson.body;

      if (relVer && findPrebuiltAssets(relJson.assets)) {
        prebuiltAvailable = true;
      } else if (relVer && compareSemver(relVer, local.version) > 0) {
        unsignedReleaseWarning = `Bản phát hành v${relVer} trên GitHub chưa đính kèm đầy đủ chữ ký số Ed25519 (.sig) nên bị chặn cập nhật tự động để bảo vệ NAS.`;
      }
    }
  } catch {
    // Keep local version info when GitHub API is unreachable
  }

  const hasSignedNewerRelease =
    compareSemver(latestVersion, local.version) > 0 && prebuiltAvailable;

  return {
    repoUrl: GITHUB_REPO_URL,
    currentVersion: local.version,
    currentCommit: local.commit ? local.commit.slice(0, 7) : null,
    latestVersion,
    latestCommit: latestCommit ? latestCommit.slice(0, 7) : null,
    latestPublishedAt,
    releaseTitle,
    changelog:
      unsignedReleaseWarning ||
      changelog ||
      'Chỉ chấp nhận các bản phát hành chính thức đã xác thực chữ ký số Ed25519 & SHA-256 trên GitHub Releases.',
    hasUpdate: hasSignedNewerRelease,
    updateInProgress: Boolean(globalThis.__nasSyncUpdating),
    canUpdateNow: unsignedReleaseWarning ? false : canUpdateNow,
    blockingReason: blockingReason || unsignedReleaseWarning || null,
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

function haveDependenciesChanged(
  oldPkgPath: string,
  newPkgPath: string,
  includeDev = false
): boolean {
  try {
    const oldPkg = JSON.parse(fs.readFileSync(oldPkgPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (
      JSON.stringify(oldPkg.dependencies || {}) !==
      JSON.stringify(newPkg.dependencies || {})
    ) {
      return true;
    }
    if (includeDev) {
      return (
        JSON.stringify(oldPkg.devDependencies || {}) !==
        JSON.stringify(newPkg.devDependencies || {})
      );
    }
    return false;
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

function readPackageIdentity(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    if (parsed.name && parsed.version) {
      return `${parsed.name}@${parsed.version}`;
    }
    return null;
  } catch {
    return null;
  }
}

function isBusyFileError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ETXTBSY' || code === 'EBUSY';
}

function copyTreePosixSafe(
  srcPath: string,
  dstPath: string,
  state: { deferredToRestart: boolean }
) {
  let srcStat: fs.Stats;
  try {
    srcStat = fs.lstatSync(srcPath);
  } catch {
    return;
  }

  if (srcStat.isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(srcPath);
      try {
        fs.unlinkSync(dstPath);
      } catch {
        // Destination does not exist
      }
      fs.symlinkSync(target, dstPath);
    } catch (err) {
      if (isBusyFileError(err)) {
        state.deferredToRestart = true;
        return;
      }
      throw err;
    }
    return;
  }

  if (srcStat.isDirectory()) {
    try {
      const dstStat = fs.lstatSync(dstPath);
      if (!dstStat.isDirectory()) {
        fs.unlinkSync(dstPath);
      }
    } catch {
      // Destination does not exist yet
    }
    fs.mkdirSync(dstPath, { recursive: true });
    for (const entry of fs.readdirSync(srcPath)) {
      copyTreePosixSafe(
        path.join(srcPath, entry),
        path.join(dstPath, entry),
        state
      );
    }
    return;
  }

  if (srcStat.isFile()) {
    try {
      try {
        const dstStat = fs.lstatSync(dstPath);
        if (dstStat.isDirectory()) {
          fs.rmSync(dstPath, { recursive: true, force: true });
        } else {
          // POSIX: unlink() tách dentry khỏi inode đang chạy (tránh lỗi ETXTBSY như esbuild/swc)
          fs.unlinkSync(dstPath);
        }
      } catch {
        // Destination does not exist yet
      }
      fs.copyFileSync(srcPath, dstPath);
      try {
        fs.chmodSync(dstPath, srcStat.mode);
      } catch {
        // Ignore chmod differences on Windows/bind mounts
      }
    } catch (err) {
      if (isBusyFileError(err)) {
        state.deferredToRestart = true;
        return;
      }
      throw err;
    }
  }
}

interface NodeModulesDeltaBackup {
  backupDir: string;
  addedRelPaths: string[];
  savedRelPaths: string[];
}

/**
 * U3 Security & Reliability Fix:
 * Chỉ sao lưu các gói bị thay đổi hoặc bị gỡ trong `/app/node_modules` trước khi hoán đổi ở bước kích hoạt cuối cùng,
 * giúp khôi phục nguyên trạng 100% trong `catch` nếu quá trình kích hoạt gặp sự cố (VD: ENOSPC).
 */
function createNodeModulesDeltaBackup(
  srcNodeModules: string,
  dstNodeModules: string,
  backupDir: string
): NodeModulesDeltaBackup {
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const addedRelPaths: string[] = [];
  const savedRelPaths: string[] = [];

  if (!fs.existsSync(dstNodeModules)) {
    return { backupDir, addedRelPaths, savedRelPaths };
  }

  const listPackageUnits = (nmDir: string): Map<string, string | null> => {
    const map = new Map<string, string | null>();
    if (!fs.existsSync(nmDir)) return map;
    for (const top of fs.readdirSync(nmDir, { withFileTypes: true })) {
      if (top.name === '.cache') continue;
      if (top.isDirectory() && top.name.startsWith('@')) {
        const scopeDir = path.join(nmDir, top.name);
        for (const scoped of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          const rel = `${top.name}/${scoped.name}`;
          map.set(rel, readPackageIdentity(path.join(nmDir, rel)));
        }
      } else {
        map.set(
          top.name,
          top.name === '.bin'
            ? null
            : readPackageIdentity(path.join(nmDir, top.name))
        );
      }
    }
    return map;
  };

  const srcMap = listPackageUnits(srcNodeModules);
  const dstMap = listPackageUnits(dstNodeModules);

  for (const [rel, srcId] of srcMap.entries()) {
    if (!dstMap.has(rel)) {
      addedRelPaths.push(rel);
      continue;
    }
    const dstId = dstMap.get(rel);
    if (srcId && dstId && srcId === dstId) {
      continue;
    }
    const existingPath = path.join(dstNodeModules, rel);
    const savedPath = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(savedPath), { recursive: true });
    fs.cpSync(existingPath, savedPath, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    savedRelPaths.push(rel);
  }

  for (const [rel] of dstMap.entries()) {
    if (!srcMap.has(rel) && rel !== '.bin' && rel !== '.cache') {
      const existingPath = path.join(dstNodeModules, rel);
      const savedPath = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.cpSync(existingPath, savedPath, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
      savedRelPaths.push(rel);
    }
  }

  return { backupDir, addedRelPaths, savedRelPaths };
}

function restoreNodeModulesDeltaBackup(
  delta: NodeModulesDeltaBackup,
  dstNodeModules: string
) {
  const dummyState = { deferredToRestart: false };
  for (const rel of delta.addedRelPaths) {
    try {
      fs.rmSync(path.join(dstNodeModules, rel), {
        recursive: true,
        force: true,
      });
    } catch {
      // Best-effort cleanup
    }
  }
  for (const rel of delta.savedRelPaths) {
    const savedPath = path.join(delta.backupDir, rel);
    const dstPath = path.join(dstNodeModules, rel);
    if (!fs.existsSync(savedPath)) continue;
    try {
      fs.rmSync(dstPath, { recursive: true, force: true });
    } catch {
      // Ignore busy binary
    }
    copyTreePosixSafe(savedPath, dstPath, dummyState);
  }
}

export function syncNodeModulesSafe(
  srcNodeModules: string,
  dstNodeModules: string
): { deferredToRestart: boolean } {
  const state = { deferredToRestart: false };
  fs.mkdirSync(dstNodeModules, { recursive: true });

  const srcTopEntries = fs.readdirSync(srcNodeModules, { withFileTypes: true });
  const srcTopNames = new Set(srcTopEntries.map((e) => e.name));

  for (const entry of srcTopEntries) {
    const srcEntryPath = path.join(srcNodeModules, entry.name);
    const dstEntryPath = path.join(dstNodeModules, entry.name);

    if (entry.isDirectory() && entry.name.startsWith('@')) {
      fs.mkdirSync(dstEntryPath, { recursive: true });
      const scopedEntries = fs.readdirSync(srcEntryPath, {
        withFileTypes: true,
      });
      const scopedNames = new Set(scopedEntries.map((e) => e.name));

      for (const scoped of scopedEntries) {
        const srcPkg = path.join(srcEntryPath, scoped.name);
        const dstPkg = path.join(dstEntryPath, scoped.name);
        if (scoped.isDirectory()) {
          const srcId = readPackageIdentity(srcPkg);
          const dstId = readPackageIdentity(dstPkg);
          if (srcId && srcId === dstId) {
            continue;
          }
          try {
            fs.rmSync(dstPkg, { recursive: true, force: true });
          } catch (err) {
            if (!isBusyFileError(err)) throw err;
          }
        }
        copyTreePosixSafe(srcPkg, dstPkg, state);
      }

      for (const existingScoped of fs.readdirSync(dstEntryPath)) {
        if (!scopedNames.has(existingScoped)) {
          try {
            fs.rmSync(path.join(dstEntryPath, existingScoped), {
              recursive: true,
              force: true,
            });
          } catch (err) {
            if (isBusyFileError(err)) state.deferredToRestart = true;
          }
        }
      }
      continue;
    }

    if (entry.isDirectory() && entry.name !== '.bin') {
      const srcId = readPackageIdentity(srcEntryPath);
      const dstId = readPackageIdentity(dstEntryPath);
      if (srcId && srcId === dstId) {
        continue;
      }
      try {
        fs.rmSync(dstEntryPath, { recursive: true, force: true });
      } catch (err) {
        if (!isBusyFileError(err)) throw err;
      }
    }

    copyTreePosixSafe(srcEntryPath, dstEntryPath, state);
  }

  for (const existingTop of fs.readdirSync(dstNodeModules)) {
    if (
      !srcTopNames.has(existingTop) &&
      existingTop !== '.bin' &&
      existingTop !== '.cache'
    ) {
      try {
        fs.rmSync(path.join(dstNodeModules, existingTop), {
          recursive: true,
          force: true,
        });
      } catch (err) {
        if (isBusyFileError(err)) state.deferredToRestart = true;
      }
    }
  }

  return state;
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
      fs.rmSync(dstItem, { force: true });
      fs.copyFileSync(srcItem, dstItem);
    }
  }
}

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

function buildNpmInstallArgs(targetDir: string, includeDev: boolean): string[] {
  const hasLockfile = fs.existsSync(path.join(targetDir, 'package-lock.json'));
  const subcommand = hasLockfile ? 'ci' : 'install';
  return [
    subcommand,
    includeDev ? '--include=dev' : '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
  ];
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
  const nmRollbackDir = path.join(releaseBaseDir, 'nm_rollback_tmp');
  const tarballPath = path.join(releaseBaseDir, 'latest-dev-sha.tar.gz');
  const prebuiltTarPath = path.join(releaseBaseDir, PREBUILT_ARCHIVE_NAME);

  const shouldSyncAppRoot =
    process.platform !== 'win32' ||
    process.env.ALLOW_LOCAL_SELF_OVERWRITE === 'true';
  const allowDevMain = isUnverifiedDevMainAllowed();

  let nmDeltaBackup: NodeModulesDeltaBackup | null = null;
  let snapshotRotated = false;

  try {
    broadcastStep(
      'CHECKING',
      5,
      'Đang kiểm tra bản phát hành đã ký số từ GitHub Releases...',
      `Kết nối tới ${GITHUB_REPO_URL}...`
    );

    const checkInfo = await checkGitHubUpdate();
    let targetVer = checkInfo.latestVersion;

    if (!checkInfo.hasUpdate && !options.force) {
      globalThis.__nasSyncUpdating = false;
      broadcastStep(
        'COMPLETED',
        100,
        `Hệ thống đang ở phiên bản mới nhất (v${targetVer}).`,
        'Không có bản phát hành đã ký nào mới hơn.',
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
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let usedPrebuiltFastPath = false;
    let resolvedCommitSha = '';
    let stagedDepsReadyToActivate = false;
    let stagedSymlinkCreated = false;

    // 2A. Luồng chuẩn mặc định (U1 & U2): BẮT BUỘC tải từ GitHub Release đã ký chữ ký số Ed25519 + SHA-256
    // Kể cả khi `options.force === true`, chỉ cài đặt lại bản phát hành đã xác thực chữ ký (KHÔNG rơi về main HEAD).
    if (!allowDevMain) {
      const relResp = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
        {
          headers: buildGitHubHeaders(),
          signal: AbortSignal.timeout(15000),
          cache: 'no-store',
        }
      );
      if (!relResp.ok) {
        throw new Error(
          `Không thể truy vấn GitHub Releases (${relResp.status} ${relResp.statusText}).`
        );
      }

      const relJson = (await relResp.json()) as GitHubReleaseResponse;
      const relTag = String(relJson.tag_name || '').trim();
      const relVer = relTag.replace(/^v/i, '');
      if (!relVer) {
        throw new Error(
          '[SECURITY] Bản phát hành GitHub không có tag phiên bản hợp lệ.'
        );
      }
      targetVer = relVer;

      const matchedAssets = findPrebuiltAssets(relJson.assets);
      if (!matchedAssets) {
        throw new Error(
          `[SECURITY] Bản phát hành v${relVer} thiếu gói Prebuilt hoặc chữ ký số Ed25519 (${PREBUILT_SIG_NAME}). Đã từ chối cập nhật tự động để bảo vệ NAS.`
        );
      }

      broadcastStep(
        'DOWNLOADING',
        20,
        `Đang tải gói phát hành v${targetVer} & xác thực chữ ký số Ed25519...`,
        `Đã sao lưu CSDL (${path.basename(
          dbBackupFile
        )}). Đang kiểm tra ${PREBUILT_SHA256_NAME} và ${PREBUILT_SIG_NAME}...`,
        targetVer
      );

      const [shaResp, sigResp] = await Promise.all([
        fetchReleaseAssetResponse(matchedAssets.shaAsset, 30000),
        fetchReleaseAssetResponse(matchedAssets.sigAsset, 30000),
      ]);
      const rawShaText = await shaResp.text();
      const rawSigText = (await sigResp.text()).trim();
      const expectedHex = (
        rawShaText.trim().split(/\s+/)[0] || ''
      ).toLowerCase();

      if (!/^[0-9a-f]{64}$/.test(expectedHex)) {
        throw new Error(
          '[SECURITY] Tệp checksum SHA-256 trên GitHub Release không đúng định dạng 64 ký tự hex.'
        );
      }

      if (!verifyReleaseSignature(relTag, expectedHex, rawSigText)) {
        throw new Error(
          `[SECURITY] Xác thực chữ ký số Ed25519 cho bản phát hành v${relVer} THẤT BẠI! Gói phát hành có dấu hiệu giả mạo hoặc chưa được ký bằng khóa chính thức. Đã hủy cập nhật ngay lập tức.`
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
        !crypto.timingSafeEqual(expectedBuf, actualBuf) ||
        !verifyReleaseSignature(relTag, actualHex, rawSigText)
      ) {
        fs.rmSync(prebuiltTarPath, { force: true });
        throw new Error(
          `[SECURITY] Sai lệch mã băm SHA-256 / chữ ký Ed25519 của gói Prebuilt (mong đợi ${expectedHex.slice(
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
        45,
        'Chữ ký số Ed25519 & SHA-256 hợp lệ 100% — Đang giải nén gói Prebuilt...',
        `Đã xác thực Ed25519 + SHA-256 (${actualHex.slice(
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
            52,
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

      const stagedPkg = JSON.parse(
        fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8')
      ) as { version?: string };
      const stagedVer = String(stagedPkg.version || '').replace(/^v/i, '');
      if (stagedVer && compareSemver(stagedVer, targetVer) !== 0) {
        throw new Error(
          `[SECURITY] Phiên bản trong package.json (${stagedVer}) không khớp với tag đã ký (${targetVer}).`
        );
      }

      try {
        const prebuiltInfo = JSON.parse(
          fs.readFileSync(path.join(stagingDir, 'BUILD_INFO.json'), 'utf8')
        ) as { commit?: string };
        if (prebuiltInfo.commit) {
          resolvedCommitSha = prebuiltInfo.commit;
        }
      } catch {
        // Ignore
      }

      const depsChanged = haveDependenciesChanged(
        path.join(appRoot, 'package.json'),
        path.join(stagingDir, 'package.json'),
        false
      );
      const stagingNodeModules = path.join(stagingDir, 'node_modules');
      fs.rmSync(stagingNodeModules, { recursive: true, force: true });

      if (depsChanged) {
        broadcastStep(
          'INSTALLING',
          65,
          'Phát hiện thư viện mới trong package.json — Đang cài đặt cô lập tại Staging...',
          'Chạy npm ci --omit=dev --ignore-scripts trong vùng Staging...',
          targetVer
        );
        const npmCode = await runStreamingCommand(
          npmBin,
          buildNpmInstallArgs(stagingDir, false),
          stagingDir,
          (line) =>
            broadcastStep(
              'INSTALLING',
              74,
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
        stagedDepsReadyToActivate = true;
      } else {
        broadcastStep(
          'INSTALLING',
          78,
          'Gói Prebuilt tương thích hoàn toàn — Bỏ qua biên dịch next build, chuẩn bị kích hoạt...',
          'Không tốn RAM/CPU biên dịch lại giao diện trên NAS (~5 giây).',
          targetVer
        );
      }

      usedPrebuiltFastPath = true;
    } else {
      // 2B. Kênh Dev thủ công (`ALLOW_UNVERIFIED_MAIN_UPDATE=true`), ghim chặt 1 SHA duy nhất để tránh TOCTOU (U5)
      const commitRes = await fetch(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`,
        {
          headers: buildGitHubHeaders(),
          signal: AbortSignal.timeout(15000),
          cache: 'no-store',
        }
      );
      if (!commitRes.ok) {
        throw new Error(
          `Không thể phân giải SHA commit trên nhánh ${GITHUB_BRANCH} (${commitRes.status}).`
        );
      }
      const commitJson = (await commitRes.json()) as { sha?: string };
      const pinnedSha = String(commitJson.sha || '').trim();
      if (!/^[0-9a-f]{40}$/i.test(pinnedSha)) {
        throw new Error(
          'SHA commit trả về từ GitHub API không hợp lệ (cần đúng 40 ký tự hex).'
        );
      }
      resolvedCommitSha = pinnedSha;

      broadcastStep(
        'DOWNLOADING',
        20,
        `[DEV MODE] Đang tải tarball ghim cứng tại commit ${pinnedSha.slice(0, 7)}...`,
        `Đã sao lưu CSDL tại ${path.basename(dbBackupFile)}. Tải tarball theo SHA bất biến...`,
        targetVer
      );

      const tarballUrl = `https://codeload.github.com/${GITHUB_OWNER}/${GITHUB_REPO}/tar.gz/${pinnedSha}`;
      const resp = await fetch(tarballUrl, {
        headers: buildGitHubHeaders(),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok || !resp.body) {
        throw new Error(
          `Không thể tải tarball commit ${pinnedSha.slice(0, 7)} từ GitHub (${resp.status}).`
        );
      }

      const fileStream = fs.createWriteStream(tarballPath);
      await pipeline(
        Readable.fromWeb(
          resp.body as unknown as import('node:stream/web').ReadableStream
        ),
        fileStream
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
        throw new Error('Giải nén gói mã nguồn từ GitHub thất bại.');
      }

      const stagedPkg = JSON.parse(
        fs.readFileSync(path.join(stagingDir, 'package.json'), 'utf8')
      ) as { version?: string };
      if (stagedPkg.version) {
        targetVer = stagedPkg.version.replace(/^v/i, '');
      }

      const depsChanged = haveDependenciesChanged(
        path.join(appRoot, 'package.json'),
        path.join(stagingDir, 'package.json'),
        true
      );
      const stagingNodeModules = path.join(stagingDir, 'node_modules');
      fs.rmSync(stagingNodeModules, { recursive: true, force: true });

      if (depsChanged) {
        broadcastStep(
          'INSTALLING',
          45,
          '[DEV MODE] Đang cài đặt dependencies cô lập tại Staging...',
          'Chạy npm ci --include=dev --ignore-scripts trong vùng Staging...'
        );
        const npmCode = await runStreamingCommand(
          npmBin,
          buildNpmInstallArgs(stagingDir, true),
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
        stagedDepsReadyToActivate = true;
      } else {
        fs.symlinkSync(
          path.join(appRoot, 'node_modules'),
          stagingNodeModules,
          process.platform === 'win32' ? 'junction' : 'dir'
        );
        stagedSymlinkCreated = true;
      }

      broadcastStep(
        'BUILDING',
        62,
        '[DEV MODE] Đang biên dịch Production UI (next build) trong vùng cô lập...',
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

      if (stagedSymlinkCreated) {
        fs.unlinkSync(stagingNodeModules);
        stagedSymlinkCreated = false;
      }
    }

    // 3. Ghi BUILD_INFO.json, lưu bản previous cho Rollback 1-Click, rồi hoán đổi nguyên tử node_modules + appRoot ở bước cuối cùng (U3)
    broadcastStep(
      'INSTALLING',
      90,
      'Đang lưu điểm khôi phục (Rollback) & kích hoạt nguyên tử phiên bản mới...',
      'Bảo toàn bản hiện hành sang live_release/previous và đồng bộ thực thi...',
      targetVer
    );

    const buildInfo = {
      name: 'nas-sync',
      version: targetVer,
      commit: resolvedCommitSha || null,
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
    snapshotRotated = true;

    const stagingNodeModules = path.join(stagingDir, 'node_modules');
    if (stagedDepsReadyToActivate && fs.existsSync(stagingNodeModules)) {
      if (shouldSyncAppRoot) {
        const appNodeModules = path.join(appRoot, 'node_modules');
        nmDeltaBackup = createNodeModulesDeltaBackup(
          stagingNodeModules,
          appNodeModules,
          nmRollbackDir
        );
        const syncRes = syncNodeModulesSafe(stagingNodeModules, appNodeModules);
        if (syncRes.deferredToRestart) {
          fs.writeFileSync(
            path.join(stagingDir, '.needs_npm_sync'),
            new Date().toISOString(),
            'utf8'
          );
        }
      }
      fs.rmSync(stagingNodeModules, { recursive: true, force: true });
    }

    fs.rmSync(currentPersistDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, currentPersistDir);

    if (shouldSyncAppRoot) {
      syncReleaseDirToAppRoot(currentPersistDir, appRoot);
    }

    if (nmDeltaBackup) {
      fs.rmSync(nmDeltaBackup.backupDir, { recursive: true, force: true });
      nmDeltaBackup = null;
    }

    setSettings({
      installed_version: targetVer,
      installed_commit_sha: resolvedCommitSha,
      last_github_update_at: new Date().toISOString(),
    });

    await createSystemAlert({
      severity: 'INFO',
      category: 'SYSTEM',
      title: `Cập nhật NAS-Sync v${targetVer} thành công`,
      message: usedPrebuiltFastPath
        ? `Hệ thống đã nâng cấp an toàn lên v${targetVer} qua gói Prebuilt xác thực chữ ký số Ed25519 & SHA-256 (có sẵn điểm Rollback 1-Click).`
        : `[DEV MODE] Hệ thống đã tải và biên dịch bản v${targetVer} (${
            resolvedCommitSha ? resolvedCommitSha.slice(0, 7) : targetVer
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
    // U3 Rollback: Khôi phục nguyên trạng node_modules và appRoot nếu sự cố xảy ra giữa bước kích hoạt cuối cùng
    try {
      if (nmDeltaBackup && shouldSyncAppRoot) {
        restoreNodeModulesDeltaBackup(
          nmDeltaBackup,
          path.join(appRoot, 'node_modules')
        );
        fs.rmSync(nmDeltaBackup.backupDir, { recursive: true, force: true });
      }
      if (
        snapshotRotated &&
        shouldSyncAppRoot &&
        fs.existsSync(path.join(previousPersistDir, 'package.json'))
      ) {
        syncReleaseDirToAppRoot(previousPersistDir, appRoot);
      }
    } catch (rollbackErr) {
      console.error(
        '[NAS-Sync Updater] Lỗi khôi phục khẩn cấp sau sự cố kích hoạt:',
        rollbackErr
      );
    }

    globalThis.__nasSyncUpdating = false;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(nmRollbackDir, { recursive: true, force: true });
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
  const nmRollbackDir = path.join(releaseBaseDir, 'nm_rollback_prev_tmp');

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

  let nmDeltaBackup: NodeModulesDeltaBackup | null = null;

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
      path.join(previousPersistDir, 'package.json'),
      false
    );

    const prevNodeModules = path.join(previousPersistDir, 'node_modules');
    fs.rmSync(prevNodeModules, { recursive: true, force: true });

    if (depsChanged) {
      broadcastStep(
        'INSTALLING',
        45,
        `Phát hiện khác biệt thư viện — Đang chuẩn bị node_modules cô lập cho v${restoredVersion}...`,
        'Chạy npm ci --omit=dev --ignore-scripts cho bản Rollback...',
        restoredVersion
      );
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmCode = await runStreamingCommand(
        npmBin,
        buildNpmInstallArgs(previousPersistDir, false),
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

    if (depsChanged && fs.existsSync(prevNodeModules)) {
      if (shouldSyncAppRoot) {
        const appNodeModules = path.join(appRoot, 'node_modules');
        nmDeltaBackup = createNodeModulesDeltaBackup(
          prevNodeModules,
          appNodeModules,
          nmRollbackDir
        );
        const syncRes = syncNodeModulesSafe(prevNodeModules, appNodeModules);
        if (syncRes.deferredToRestart) {
          fs.writeFileSync(
            path.join(previousPersistDir, '.needs_npm_sync'),
            new Date().toISOString(),
            'utf8'
          );
        }
      }
      fs.rmSync(prevNodeModules, { recursive: true, force: true });
    }

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

    if (nmDeltaBackup) {
      fs.rmSync(nmDeltaBackup.backupDir, { recursive: true, force: true });
      nmDeltaBackup = null;
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
    try {
      if (nmDeltaBackup && shouldSyncAppRoot) {
        restoreNodeModulesDeltaBackup(
          nmDeltaBackup,
          path.join(appRoot, 'node_modules')
        );
        fs.rmSync(nmDeltaBackup.backupDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore rollback cleanup failure
    }
    fs.rmSync(nmRollbackDir, { recursive: true, force: true });
    globalThis.__nasSyncUpdating = false;
    const msg =
      (err as Error).message || 'Lỗi không xác định khi Rollback phiên bản.';
    broadcastStep('FAILED', 0, msg, `❌ Lỗi Rollback: ${msg}`);
    throw err;
  }
}

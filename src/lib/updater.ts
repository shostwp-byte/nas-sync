import { spawn } from 'node:child_process';
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

function getActiveBlockingReason(): {
  canUpdateNow: boolean;
  blockingReason: string | null;
} {
  if (globalThis.__nasSyncUpdating) {
    return {
      canUpdateNow: false,
      blockingReason: 'Hệ thống đang thực thi tiến trình cập nhật.',
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
    'User-Agent': 'nas-sync-self-updater/1.1',
  };
  const token =
    process.env.GITHUB_TOKEN || getSetting('github_token', '').trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function checkGitHubUpdate(): Promise<SystemUpdateInfo> {
  const local = getLocalBuildMetadata();
  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  const headers = buildGitHubHeaders();

  let latestVersion = local.version;
  let latestCommit: string | null = local.commit;
  let latestPublishedAt: string | null = null;
  let releaseTitle: string | null = null;
  let changelog = '';

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
      const relJson = (await releaseRes.value.json()) as {
        tag_name?: string;
        name?: string;
        body?: string;
        published_at?: string;
      };
      if (relJson.tag_name) {
        const relVer = relJson.tag_name.replace(/^v/i, '');
        if (compareSemver(relVer, latestVersion) >= 0) {
          latestVersion = relVer;
        }
      }
      if (relJson.name) releaseTitle = relJson.name;
      if (relJson.published_at) latestPublishedAt = relJson.published_at;
      if (relJson.body) changelog = relJson.body;
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
  onLine: (line: string) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    });

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
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function backupSqliteBeforeUpdate(): string {
  const dbFile = getDbFilePath();
  const backupsDir = path.join(getDataDir(), 'db_backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir, `nas-sync-pre-update-${stamp}.db`);
  if (fs.existsSync(dbFile)) {
    fs.copyFileSync(dbFile, dest);
  }

  // Giữ tối đa 5 bản sao lưu CSDL gần nhất
  const all = fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse();
  for (const old of all.slice(5)) {
    fs.rmSync(path.join(backupsDir, old), { force: true });
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

export async function performGitHubUpdate(options: {
  force?: boolean;
} = {}): Promise<void> {
  const { canUpdateNow, blockingReason } = getActiveBlockingReason();
  if (!canUpdateNow && !options.force) {
    throw new Error(blockingReason || 'Không thể cập nhật ngay lúc này.');
  }

  globalThis.__nasSyncUpdating = true;

  const appRoot = process.cwd();
  const releaseBaseDir = path.join(getDataDir(), 'live_release');
  const stagingDir = path.join(releaseBaseDir, 'staging');
  const currentPersistDir = path.join(releaseBaseDir, 'current');
  const tarballPath = path.join(releaseBaseDir, 'latest-main.tar.gz');

  try {
    broadcastStep(
      'CHECKING',
      5,
      'Đang kiểm tra thông tin bản phát hành từ GitHub...',
      `Kết nối tới ${GITHUB_REPO_URL} (nhánh ${GITHUB_BRANCH})...`
    );

    const checkInfo = await checkGitHubUpdate();
    const targetVer = checkInfo.latestVersion;

    // 1. Sao lưu CSDL SQLite trước khi cập nhật
    broadcastStep(
      'DOWNLOADING',
      12,
      'Đang tạo bản sao lưu an toàn CSDL quản trị...',
      'Sao lưu tự động CSDL SQLite trước khi nâng cấp...'
    );
    const dbBackupFile = backupSqliteBeforeUpdate();
    broadcastStep(
      'DOWNLOADING',
      18,
      'Đang tải gói mã nguồn mới nhất từ GitHub...',
      `Đã sao lưu CSDL tại ${path.basename(dbBackupFile)}. Bắt đầu tải tarball...`,
      targetVer
    );

    // 2. Tải tarball trực tiếp từ GitHub codeload
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

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
      Readable.fromWeb(resp.body as unknown as import('node:stream/web').ReadableStream),
      fileStream
    );

    broadcastStep(
      'DOWNLOADING',
      32,
      'Đang giải nén gói mã nguồn vào vùng Staging...',
      'Đã tải xong tarball từ GitHub. Đang giải nén...'
    );

    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const untarCode = await runStreamingCommand(
      tarBin,
      ['-xzf', tarballPath, '--strip-components=1', '-C', stagingDir],
      releaseBaseDir,
      (line) => broadcastStep('DOWNLOADING', 35, 'Đang giải nén...', line)
    );
    fs.rmSync(tarballPath, { force: true });

    if (untarCode !== 0 || !fs.existsSync(path.join(stagingDir, 'package.json'))) {
      throw new Error('Giải nén gói cập nhật từ GitHub thất bại.');
    }

    // 3. Kiểm tra dependencies và liên kết node_modules
    const depsChanged = haveDependenciesChanged(
      path.join(appRoot, 'package.json'),
      path.join(stagingDir, 'package.json')
    );

    if (depsChanged) {
      broadcastStep(
        'INSTALLING',
        45,
        'Phát hiện thư viện mới trong package.json — Đang cài đặt npm packages...',
        'Chạy npm install --include=dev...'
      );
      fs.copyFileSync(
        path.join(stagingDir, 'package.json'),
        path.join(appRoot, 'package.json')
      );
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmCode = await runStreamingCommand(
        npmBin,
        ['install', '--include=dev', '--no-audit', '--no-fund'],
        appRoot,
        (line) =>
          broadcastStep('INSTALLING', 52, 'Đang cài đặt thư viện mới...', line)
      );
      if (npmCode !== 0) {
        throw new Error('Cài đặt gói phụ thuộc npm thất bại.');
      }
    } else {
      broadcastStep(
        'INSTALLING',
        48,
        'Các gói node_modules không đổi — Tái sử dụng tức thì...',
        'Liên kết node_modules hiện hành sang vùng Staging (0s)...'
      );
    }

    const stagingNodeModules = path.join(stagingDir, 'node_modules');
    fs.rmSync(stagingNodeModules, { recursive: true, force: true });
    fs.symlinkSync(
      path.join(appRoot, 'node_modules'),
      stagingNodeModules,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    // 4. Chạy Production Build (next build) trong vùng Staging cô lập
    broadcastStep(
      'BUILDING',
      60,
      'Đang biên dịch Production UI (next build) trong vùng cô lập...',
      'Khởi chạy Next.js Production Build...'
    );

    const nextBin = path.join(
      appRoot,
      'node_modules',
      'next',
      'dist',
      'bin',
      'next'
    );
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

    // 5. Ghi BUILD_INFO.json và lưu bền vững vào /app/data/live_release/current
    broadcastStep(
      'INSTALLING',
      90,
      'Đang kích hoạt bản cập nhật bền vững lên hệ thống...',
      'Ghi nhận BUILD_INFO.json và đồng bộ vào thư mục thực thi...'
    );

    // Gỡ symlink node_modules trước khi lưu bền vững
    fs.unlinkSync(stagingNodeModules);

    let fullCommit = checkInfo.latestCommit || '';
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

    const buildInfo = {
      name: 'nas-sync',
      version: targetVer,
      commit: fullCommit || null,
      updatedAt: new Date().toISOString(),
      source: GITHUB_REPO_URL,
    };
    fs.writeFileSync(
      path.join(stagingDir, 'BUILD_INFO.json'),
      JSON.stringify(buildInfo, null, 2),
      'utf8'
    );

    const prevPersistBackup = `${currentPersistDir}.bak`;
    fs.rmSync(prevPersistBackup, { recursive: true, force: true });
    if (fs.existsSync(currentPersistDir)) {
      fs.renameSync(currentPersistDir, prevPersistBackup);
    }
    fs.renameSync(stagingDir, currentPersistDir);
    fs.rmSync(prevPersistBackup, { recursive: true, force: true });

    // Đồng bộ sang thư mục thực thi hiện tại (/app trên Docker)
    const syncTargets = [
      'src',
      '.next',
      'server.ts',
      'package.json',
      'next.config.mjs',
      'postcss.config.mjs',
      'tailwind.config.ts',
      'tsconfig.json',
      'BUILD_INFO.json',
    ];

    // Chỉ ghi đè trực tiếp vào appRoot trên môi trường Container/Production (không ghi đè workspace Git khi dev trên Windows)
    if (process.platform !== 'win32' || process.env.ALLOW_LOCAL_SELF_OVERWRITE === 'true') {
      for (const item of syncTargets) {
        const srcItem = path.join(currentPersistDir, item);
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

    setSettings({
      installed_version: targetVer,
      installed_commit_sha: fullCommit,
      last_github_update_at: new Date().toISOString(),
    });

    await createSystemAlert({
      severity: 'INFO',
      category: 'SYSTEM',
      title: `Cập nhật NAS-Sync v${targetVer} thành công`,
      message: `Hệ thống đã tự động tải và biên dịch bản cập nhật mới nhất (${
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
        `Đã tải & kiểm tra build v${targetVer} thành công tại ${currentPersistDir}! (Môi trường Windows Dev: khởi động lại server để nạp bản mới).`,
        'Hoàn tất kiểm tra cập nhật trên Windows.',
        targetVer
      );
    }
  } catch (err) {
    globalThis.__nasSyncUpdating = false;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(tarballPath, { force: true });
    const msg = (err as Error).message || 'Lỗi không xác định khi cập nhật từ GitHub.';
    broadcastStep('FAILED', 0, msg, `❌ Lỗi: ${msg}`);
    throw err;
  }
}


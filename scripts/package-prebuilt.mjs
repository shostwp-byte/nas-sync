import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const nextBuildIdPath = path.join(projectRoot, '.next', 'BUILD_ID');

if (!fs.existsSync(nextBuildIdPath)) {
  console.error(
    '❌ Không tìm thấy .next/BUILD_ID! Vui lòng chạy `npm run build` trước khi đóng gói Prebuilt.'
  );
  process.exit(1);
}

const releaseDir = path.join(projectRoot, 'release');
const tempStageBase = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nas-sync-prebuilt-')
);
const bundleFolderName = 'nas-sync-prebuilt';
const stageDir = path.join(tempStageBase, bundleFolderName);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.sh',
]);

const ROOT_FILES = [
  'server.ts',
  'package.json',
  'package-lock.json',
  'next.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'tsconfig.json',
  'docker-entrypoint.sh',
];

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function copyFileNormalizedLf(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isTextFile(src)) {
    const content = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(dest, content, 'utf8');
  } else {
    fs.copyFileSync(src, dest);
  }
}

function copyDirectoryRecursiveLf(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursiveLf(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileNormalizedLf(srcPath, destPath);
    }
  }
}

console.log('1. Chuẩn bị vùng Staging cho gói Prebuilt NAS-Sync...');
fs.mkdirSync(stageDir, { recursive: true });

for (const relFile of ROOT_FILES) {
  const src = path.join(projectRoot, relFile);
  if (fs.existsSync(src)) {
    copyFileNormalizedLf(src, path.join(stageDir, relFile));
  }
}

// Sao chép src/ (chuẩn hóa LF)
copyDirectoryRecursiveLf(
  path.join(projectRoot, 'src'),
  path.join(stageDir, 'src')
);

// Sao chép public/ và công cụ giải mã khẩn cấp scripts/decrypt-offsite-backup.mjs nếu có
const publicSrc = path.join(projectRoot, 'public');
if (fs.existsSync(publicSrc)) {
  fs.cpSync(publicSrc, path.join(stageDir, 'public'), {
    recursive: true,
    force: true,
  });
}
const decryptCliSrc = path.join(projectRoot, 'scripts', 'decrypt-offsite-backup.mjs');
if (fs.existsSync(decryptCliSrc)) {
  copyFileNormalizedLf(
    decryptCliSrc,
    path.join(stageDir, 'scripts', 'decrypt-offsite-backup.mjs')
  );
}

// Sao chép .next/ nhưng loại bỏ hoàn toàn .next/cache/ để giảm dung lượng gói từ ~80MB xuống ~3-6MB
const nextSrcDir = path.join(projectRoot, '.next');
const nextCacheDir = path.resolve(nextSrcDir, 'cache');
fs.cpSync(nextSrcDir, path.join(stageDir, '.next'), {
  recursive: true,
  force: true,
  filter: (src) => {
    const resolved = path.resolve(src);
    return (
      resolved !== nextCacheDir &&
      !resolved.startsWith(nextCacheDir + path.sep)
    );
  },
});

const pkg = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
);
let gitCommit = process.env.GITHUB_SHA || null;
if (!gitCommit) {
  try {
    const headPath = path.join(projectRoot, '.git', 'HEAD');
    if (fs.existsSync(headPath)) {
      const headRaw = fs.readFileSync(headPath, 'utf8').trim();
      if (headRaw.startsWith('ref: ')) {
        const refPath = path.join(projectRoot, '.git', headRaw.slice(5).trim());
        if (fs.existsSync(refPath)) {
          gitCommit = fs.readFileSync(refPath, 'utf8').trim();
        }
      } else if (/^[0-9a-f]{40}$/i.test(headRaw)) {
        gitCommit = headRaw;
      }
    }
  } catch {
    // Ignore
  }
}

fs.writeFileSync(
  path.join(stageDir, 'BUILD_INFO.json'),
  JSON.stringify(
    {
      name: 'nas-sync',
      version: pkg.version || '1.3.0',
      commit: gitCommit,
      prebuilt: true,
      builtAt: new Date().toISOString(),
      source: 'https://github.com/shostwp-byte/nas-sync',
    },
    null,
    2
  ) + '\n',
  'utf8'
);

fs.mkdirSync(releaseDir, { recursive: true });
const archiveFileName = 'nas-sync-prebuilt.tar.gz';
const sha256FileName = 'nas-sync-prebuilt.tar.gz.sha256';
const tarGzOut = path.join(releaseDir, archiveFileName);
const sha256Out = path.join(releaseDir, sha256FileName);

if (fs.existsSync(tarGzOut)) fs.unlinkSync(tarGzOut);
if (fs.existsSync(sha256Out)) fs.unlinkSync(sha256Out);

const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
console.log('2. Đang đóng gói nas-sync-prebuilt.tar.gz & sinh chữ ký SHA-256...');
execFileSync(
  tarCmd,
  ['-czf', tarGzOut, '-C', tempStageBase, bundleFolderName],
  { stdio: 'inherit' }
);

fs.rmSync(tempStageBase, { recursive: true, force: true });

const archiveBytes = fs.readFileSync(tarGzOut);
const sha256Hex = crypto
  .createHash('sha256')
  .update(archiveBytes)
  .digest('hex');

fs.writeFileSync(sha256Out, `${sha256Hex}  ${archiveFileName}\n`, 'utf8');

const sizeMb = (archiveBytes.length / (1024 * 1024)).toFixed(2);
console.log('\n✅ ĐÓNG GÓI PREBUILT NAS-SYNC HOÀN TẤT:');
console.log(`   - Gói Prebuilt: ${tarGzOut} (${sizeMb} MB)`);
console.log(`   - SHA-256:      ${sha256Hex} (${sha256Out})`);

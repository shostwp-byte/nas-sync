import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const releaseDir = path.join(projectRoot, 'release');
const tempStageBase = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-sync-pack-'));
const bundleFolderName = 'nas-sync';
const stageDir = path.join(tempStageBase, bundleFolderName);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.sh',
  '.example',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.dockerignore',
]);

const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'next.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'server.ts',
  'Dockerfile',
  'docker-entrypoint.sh',
  'docker-compose.yml',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.env.example',
  'install-synology.sh',
  'update-synology.sh',
  'LICENSE',
  'README.md',
  'CHANGELOG.md',
  'HUONG-DAN-CAI-DAT-SYNOLOGY.md',
];

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (
    base === 'Dockerfile' ||
    base === 'LICENSE' ||
    base === '.dockerignore' ||
    base === '.gitignore' ||
    base === '.gitattributes' ||
    base === '.editorconfig' ||
    base === '.env' ||
    base === '.env.example'
  ) {
    return true;
  }
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

function copyDirectoryRecursive(srcDir, destDir) {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      copyFileNormalizedLf(srcPath, destPath);
    }
  }
}

console.log('1. Chuẩn bị thư mục đóng gói sạch NAS-Sync (chuẩn hóa dòng LF cho Linux/Synology)...');
fs.mkdirSync(stageDir, { recursive: true });

for (const relFile of INCLUDE_FILES) {
  const src = path.join(projectRoot, relFile);
  if (fs.existsSync(src)) {
    copyFileNormalizedLf(src, path.join(stageDir, relFile));
  }
}

// Tạo BUILD_INFO.json để ứng dụng biết chính xác phiên bản & commit gốc khi kiểm tra Update từ GitHub
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
let gitCommit = null;
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
  // Ignore if .git not initialized yet
}

fs.writeFileSync(
  path.join(stageDir, 'BUILD_INFO.json'),
  JSON.stringify(
    {
      name: 'nas-sync',
      version: pkg.version || '1.1.0',
      commit: gitCommit,
      builtAt: new Date().toISOString(),
      source: 'https://github.com/shostwp-byte/nas-sync',
    },
    null,
    2
  ) + '\n',
  'utf8'
);

// Tạo sẵn file .env mặc định từ .env.example để Synology Container Manager GUI dùng được ngay sau khi giải nén
copyFileNormalizedLf(
  path.join(projectRoot, '.env.example'),
  path.join(stageDir, '.env')
);

// Sao chép toàn bộ thư mục mã nguồn src/
copyDirectoryRecursive(
  path.join(projectRoot, 'src'),
  path.join(stageDir, 'src')
);

// Tạo sẵn thư mục bind-mount để Synology Container Manager không báo lỗi "Bind mount folder does not exist"
for (const emptyDir of ['app_data', 'ssh_keys']) {
  const p = path.join(stageDir, emptyDir);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, '.gitkeep'), '', 'utf8');
}

fs.mkdirSync(releaseDir, { recursive: true });

// Xóa gói tên cũ nếu còn tồn tại
for (const legacyName of ['shost-backup-synology.zip', 'shost-backup-synology.tar.gz']) {
  const lp = path.join(releaseDir, legacyName);
  if (fs.existsSync(lp)) fs.unlinkSync(lp);
}

const zipOut = path.join(releaseDir, 'nas-sync-synology.zip');
const tarGzOut = path.join(releaseDir, 'nas-sync-synology.tar.gz');

if (fs.existsSync(zipOut)) fs.unlinkSync(zipOut);
if (fs.existsSync(tarGzOut)) fs.unlinkSync(tarGzOut);

const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
console.log('2. Đang nén gói chuẩn POSIX (.zip & .tar.gz)...');
if (process.platform === 'win32') {
  execFileSync(tarCmd, ['-a', '-cf', zipOut, '-C', tempStageBase, bundleFolderName], {
    stdio: 'inherit',
  });
} else {
  execFileSync('zip', ['-rq', zipOut, bundleFolderName], {
    cwd: tempStageBase,
    stdio: 'inherit',
  });
}
execFileSync(tarCmd, ['-czf', tarGzOut, '-C', tempStageBase, bundleFolderName], {
  stdio: 'inherit',
});

fs.rmSync(tempStageBase, { recursive: true, force: true });

const zipSizeKb = (fs.statSync(zipOut).size / 1024).toFixed(1);
const tarSizeKb = (fs.statSync(tarGzOut).size / 1024).toFixed(1);

console.log('\n✅ ĐÓNG GÓI NAS-SYNC HOÀN TẤT:');
console.log(`   - File ZIP (Dùng cho File Station GUI): ${zipOut} (${zipSizeKb} KB)`);
console.log(`   - File TAR.GZ (Dùng cho SSH / Linux):   ${tarGzOut} (${tarSizeKb} KB)`);

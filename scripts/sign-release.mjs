import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BUNDLE_SIGNATURE_DOMAIN,
  DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM,
  PREBUILT_SIGNATURE_DOMAIN,
} from '../src/lib/release-public-key.mjs';

function parseTagArg() {
  const idx = process.argv.indexOf('--tag');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.version) return pkg.version;
  }
  return '';
}

const rawTag = parseTagArg();
const cleanTag = String(rawTag || '')
  .trim()
  .replace(/^refs\/tags\//i, '')
  .replace(/^v/i, '');

if (!cleanTag || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(cleanTag)) {
  console.error(`❌ Tag phát hành không hợp lệ: "${rawTag}"`);
  process.exit(1);
}

const rawPrivKey = process.env.RELEASE_SIGNING_PRIVATE_KEY || '';
if (!rawPrivKey.trim()) {
  console.error(
    '❌ Thiếu biến môi trường RELEASE_SIGNING_PRIVATE_KEY (Ed25519 PKCS#8 PEM). Vui lòng cấu hình trong GitHub Environment release-signing trước khi phát hành.'
  );
  process.exit(1);
}

const normalizedPrivPem = rawPrivKey.replace(/\\n/g, '\n').trim();
const privKeyObj = crypto.createPrivateKey(normalizedPrivPem);

const activePubPem = (
  process.env.NAS_SYNC_RELEASE_PUBLIC_KEY_PEM ||
  DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM
)
  .replace(/\\n/g, '\n')
  .trim();
const pubKeyObj = crypto.createPublicKey(activePubPem);

const releaseDir = path.join(process.cwd(), 'release');

function signAndVerifyArtifact({ archiveName, domain, required }) {
  const archivePath = path.join(releaseDir, archiveName);
  const sha256Path = `${archivePath}.sha256`;
  const sigOutPath = `${archivePath}.sig`;

  if (!fs.existsSync(sha256Path)) {
    if (!required) return;
    console.error(`❌ Không tìm thấy tệp checksum: ${sha256Path}`);
    process.exit(1);
  }

  const recordedSha = fs
    .readFileSync(sha256Path, 'utf8')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();

  if (!/^[0-9a-f]{64}$/.test(recordedSha)) {
    console.error(`❌ Nội dung SHA-256 không hợp lệ trong ${sha256Path}`);
    process.exit(1);
  }

  if (fs.existsSync(archivePath)) {
    const actualSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(archivePath))
      .digest('hex')
      .toLowerCase();
    if (actualSha !== recordedSha) {
      console.error(
        `❌ Mã băm SHA-256 thực tế của ${archiveName} (${actualSha}) KHÔNG khớp với tệp .sha256 (${recordedSha})!`
      );
      process.exit(1);
    }
  } else if (required && process.env.CI === 'true') {
    console.error(`❌ Thiếu tệp nén cần ký trong CI: ${archivePath}`);
    process.exit(1);
  }

  const payload = Buffer.from(`${domain}|${cleanTag}|${recordedSha}`, 'utf8');
  const sigBuf = crypto.sign(null, payload, privKeyObj);

  // U16 Fix: Luôn xác minh chữ ký với khóa công khai nhúng (không còn cờ bỏ qua kiểm tra)
  const verified = crypto.verify(null, payload, pubKeyObj, sigBuf);
  if (!verified) {
    console.error(
      '❌ Chữ ký Ed25519 vừa tạo KHÔNG khớp với khóa công khai chuẩn trong src/lib/release-public-key.mjs!'
    );
    process.exit(1);
  }

  fs.writeFileSync(sigOutPath, `${sigBuf.toString('base64')}\n`, 'utf8');
  console.log(
    `✅ Đã ký số Ed25519 (${domain}) cho v${cleanTag} -> ${sigOutPath}`
  );
}

signAndVerifyArtifact({
  archiveName: 'nas-sync-prebuilt.tar.gz',
  domain: PREBUILT_SIGNATURE_DOMAIN,
  required: true,
});

signAndVerifyArtifact({
  archiveName: 'nas-sync-bundle.tar.gz',
  domain: BUNDLE_SIGNATURE_DOMAIN,
  required: fs.existsSync(
    path.join(releaseDir, 'nas-sync-bundle.tar.gz.sha256')
  ),
});

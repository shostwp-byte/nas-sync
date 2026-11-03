import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApSztKo5UUyVAV5hfAmATSIyCR6Teo3PDUEkE4HXi30Q=
-----END PUBLIC KEY-----`;

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

const releaseDir = path.join(process.cwd(), 'release');
const sha256Path = path.join(releaseDir, 'nas-sync-prebuilt.tar.gz.sha256');
const sigOutPath = path.join(releaseDir, 'nas-sync-prebuilt.tar.gz.sig');

if (!fs.existsSync(sha256Path)) {
  console.error(`❌ Không tìm thấy tệp checksum: ${sha256Path}`);
  process.exit(1);
}

const sha256Hex = fs
  .readFileSync(sha256Path, 'utf8')
  .trim()
  .split(/\s+/)[0]
  .toLowerCase();

if (!/^[0-9a-f]{64}$/.test(sha256Hex)) {
  console.error(`❌ Nội dung SHA-256 không hợp lệ trong ${sha256Path}`);
  process.exit(1);
}

const rawPrivKey = process.env.RELEASE_SIGNING_PRIVATE_KEY || '';
if (!rawPrivKey.trim()) {
  console.error(
    '❌ Thiếu biến môi trường RELEASE_SIGNING_PRIVATE_KEY (Ed25519 PKCS#8 PEM). Vui lòng cấu hình trong GitHub Repository Secrets trước khi phát hành.'
  );
  process.exit(1);
}

const normalizedPrivPem = rawPrivKey.replace(/\\n/g, '\n').trim();
const payload = Buffer.from(
  `nas-sync-release-v1|${cleanTag}|${sha256Hex}`,
  'utf8'
);

const privKeyObj = crypto.createPrivateKey(normalizedPrivPem);
const sigBuf = crypto.sign(null, payload, privKeyObj);
const sigBase64 = sigBuf.toString('base64');

const activePubPem = (
  process.env.NAS_SYNC_RELEASE_PUBLIC_KEY_PEM ||
  DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM
)
  .replace(/\\n/g, '\n')
  .trim();

if (process.env.SKIP_DEFAULT_PUBKEY_CHECK !== 'true') {
  const pubKeyObj = crypto.createPublicKey(activePubPem);
  const verified = crypto.verify(null, payload, pubKeyObj, sigBuf);
  if (!verified) {
    console.error(
      '❌ Chữ ký Ed25519 vừa tạo KHÔNG khớp với khóa công khai nhúng trong mã nguồn (src/lib/release-signature.ts)!'
    );
    process.exit(1);
  }
}

fs.writeFileSync(sigOutPath, `${sigBase64}\n`, 'utf8');
console.log(
  `✅ Đã ký số Ed25519 thành công cho bản phát hành v${cleanTag} -> ${sigOutPath}`
);


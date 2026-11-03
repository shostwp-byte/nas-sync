import crypto from 'node:crypto';

/**
 * U1 & U2 Security Fix:
 * Khóa công khai Ed25519 chính thức dùng để xác thực nguồn gốc và tính toàn vẹn của gói phát hành Prebuilt
 * (`nas-sync-prebuilt.tar.gz` + `.sha256` + `.sig`).
 * Cho phép ghi đè qua biến môi trường `NAS_SYNC_RELEASE_PUBLIC_KEY_PEM` đối với bản fork nội bộ hoặc kiểm thử tự động.
 */
export const DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApSztKo5UUyVAV5hfAmATSIyCR6Teo3PDUEkE4HXi30Q=
-----END PUBLIC KEY-----`;

export function normalizeReleaseTag(tag: string): string {
  const cleaned = String(tag || '')
    .trim()
    .replace(/^refs\/tags\//i, '')
    .replace(/^v/i, '');
  if (!cleaned || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(cleaned)) {
    throw new Error(`Tag phiên bản phát hành không hợp lệ: "${tag}"`);
  }
  return cleaned;
}

export function normalizeSha256Hex(sha256Hex: string): string {
  const cleaned = String(sha256Hex || '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) {
    throw new Error('Mã băm SHA-256 không đúng định dạng 64 ký tự hex.');
  }
  return cleaned;
}

export function buildReleaseSignaturePayload(
  tag: string,
  sha256Hex: string
): Buffer {
  const cleanTag = normalizeReleaseTag(tag);
  const cleanSha = normalizeSha256Hex(sha256Hex);
  return Buffer.from(`nas-sync-release-v1|${cleanTag}|${cleanSha}`, 'utf8');
}

export function getActiveReleasePublicKeyPem(overridePem?: string): string {
  const raw =
    overridePem ||
    process.env.NAS_SYNC_RELEASE_PUBLIC_KEY_PEM ||
    DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM;
  return raw.replace(/\\n/g, '\n').trim();
}

export function signReleasePayload(
  tag: string,
  sha256Hex: string,
  privateKeyPem: string
): string {
  const payload = buildReleaseSignaturePayload(tag, sha256Hex);
  const normalizedKey = String(privateKeyPem || '').replace(/\\n/g, '\n').trim();
  const keyObj = crypto.createPrivateKey(normalizedKey);
  const sig = crypto.sign(null, payload, keyObj);
  return sig.toString('base64');
}

export function verifyReleaseSignature(
  tag: string,
  sha256Hex: string,
  signatureBase64: string,
  publicKeyPem?: string
): boolean {
  try {
    const payload = buildReleaseSignaturePayload(tag, sha256Hex);
    const cleanSigB64 = String(signatureBase64 || '')
      .trim()
      .split(/\s+/)[0];
    if (!cleanSigB64 || !/^[A-Za-z0-9+/=]+$/.test(cleanSigB64)) {
      return false;
    }
    const sigBuf = Buffer.from(cleanSigB64, 'base64');
    if (sigBuf.length !== 64) {
      return false;
    }
    const pubPem = getActiveReleasePublicKeyPem(publicKeyPem);
    const pubKeyObj = crypto.createPublicKey(pubPem);
    return crypto.verify(null, payload, pubKeyObj, sigBuf);
  } catch {
    return false;
  }
}


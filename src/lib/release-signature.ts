import crypto from 'node:crypto';
import {
  BUNDLE_SIGNATURE_DOMAIN,
  DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM,
  PREBUILT_SIGNATURE_DOMAIN,
} from './release-public-key.mjs';

export {
  BUNDLE_SIGNATURE_DOMAIN,
  DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM,
  PREBUILT_SIGNATURE_DOMAIN,
};

export type ReleaseSignatureDomain =
  | typeof PREBUILT_SIGNATURE_DOMAIN
  | typeof BUNDLE_SIGNATURE_DOMAIN;

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
  sha256Hex: string,
  domain: ReleaseSignatureDomain = PREBUILT_SIGNATURE_DOMAIN
): Buffer {
  const cleanTag = normalizeReleaseTag(tag);
  const cleanSha = normalizeSha256Hex(sha256Hex);
  return Buffer.from(`${domain}|${cleanTag}|${cleanSha}`, 'utf8');
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
  privateKeyPem: string,
  domain: ReleaseSignatureDomain = PREBUILT_SIGNATURE_DOMAIN
): string {
  const payload = buildReleaseSignaturePayload(tag, sha256Hex, domain);
  const normalizedKey = String(privateKeyPem || '').replace(/\\n/g, '\n').trim();
  const keyObj = crypto.createPrivateKey(normalizedKey);
  const sig = crypto.sign(null, payload, keyObj);
  return sig.toString('base64');
}

export function verifyReleaseSignature(
  tag: string,
  sha256Hex: string,
  signatureBase64: string,
  publicKeyPem?: string,
  domain: ReleaseSignatureDomain = PREBUILT_SIGNATURE_DOMAIN
): boolean {
  try {
    const payload = buildReleaseSignaturePayload(tag, sha256Hex, domain);
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

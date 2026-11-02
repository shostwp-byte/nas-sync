import crypto from 'node:crypto';
import { ensureJwtSecret } from './jwt-secret';
import { renderQrSvg } from './qr-svg';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 ký tự rõ ràng, không gây nhầm lẫn 0/O/1/I
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

function getTotpDerivedKey(): Buffer {
  if (!process.env.JWT_SECRET) {
    ensureJwtSecret();
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET chưa sẵn sàng để mã hóa khóa 2FA.');
  }
  return crypto
    .createHash('sha256')
    .update('nas-sync-totp:' + jwtSecret)
    .digest();
}

export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return out;
}

export function decodeBase32(input: string): Buffer {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/[\s=-]+/g, '');
  if (!cleaned) {
    throw new Error('Chuỗi khóa Base32 không được để trống.');
  }

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Ký tự Base32 không hợp lệ: "${cleaned[i]}"`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20): string {
  return encodeBase32(crypto.randomBytes(byteLength));
}

export function encryptTotpSecret(plainBase32Secret: string): string {
  const key = getTotpDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainBase32Secret, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptTotpSecret(encryptedPayload: string): string {
  const parts = String(encryptedPayload || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Định dạng khóa 2FA đã mã hóa không hợp lệ.');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Metadata giải mã khóa 2FA không hợp lệ.');
  }
  const key = getTotpDerivedKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

function computeHotp(secretBytes: Buffer, counter: bigint, digits = TOTP_DIGITS): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, '0');
}

export function generateTotpCode(
  base32Secret: string,
  timestampMs = Date.now()
): string {
  const secretBytes = decodeBase32(base32Secret);
  const step = BigInt(Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS));
  return computeHotp(secretBytes, step, TOTP_DIGITS);
}

/**
 * Xác thực mã TOTP 6 chữ số theo chuẩn RFC 6238 (HMAC-SHA1, chu kỳ 30 giây).
 * Mặc định chấp nhận sai lệch ±1 chu kỳ (±30 giây) để tránh lệch đồng hồ nhẹ giữa NAS và điện thoại.
 */
export function verifyTotpCode(
  base32Secret: string,
  inputCode: string,
  timestampMs = Date.now(),
  window = 1
): boolean {
  const cleaned = String(inputCode || '').replace(/[\s-]+/g, '');
  if (!/^\d{6}$/.test(cleaned)) {
    return false;
  }

  let secretBytes: Buffer;
  try {
    secretBytes = decodeBase32(base32Secret);
  } catch {
    return false;
  }

  const currentStep = BigInt(Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS));
  const candidateBuf = Buffer.from(cleaned, 'utf8');

  for (let offset = -window; offset <= window; offset++) {
    const step = currentStep + BigInt(offset);
    if (step < BigInt(0)) continue;
    const expectedBuf = Buffer.from(
      computeHotp(secretBytes, step, TOTP_DIGITS),
      'utf8'
    );
    if (
      expectedBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(expectedBuf, candidateBuf)
    ) {
      return true;
    }
  }

  return false;
}

export function buildOtpAuthUrl(
  username: string,
  base32Secret: string,
  issuer = 'NAS-Sync'
): string {
  const cleanSecret = base32Secret.replace(/[\s=-]+/g, '').toUpperCase();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  return `otpauth://totp/${label}?secret=${cleanSecret}&issuer=${encodeURIComponent(
    issuer
  )}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

export async function generateTotpQrSvg(otpauthUrl: string): Promise<string> {
  return renderQrSvg(otpauthUrl, {
    margin: 1,
    width: 200,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });
}

function hashRecoveryCodeNormalized(normalizedCode: string): string {
  return crypto
    .createHmac('sha256', getTotpDerivedKey())
    .update('recovery:' + normalizedCode)
    .digest('hex');
}

export function generateRecoveryCodes(count = 8): {
  plainCodes: string[];
  hashedJson: string;
} {
  const plainCodes: string[] = [];
  const hashedCodes: string[] = [];

  for (let i = 0; i < count; i++) {
    const rand = crypto.randomBytes(8);
    let chars = '';
    for (let j = 0; j < 8; j++) {
      chars += RECOVERY_ALPHABET[rand[j] & 31];
    }
    const formatted = `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
    plainCodes.push(formatted);
    hashedCodes.push(hashRecoveryCodeNormalized(chars));
  }

  return {
    plainCodes,
    hashedJson: JSON.stringify(hashedCodes),
  };
}

export function countRemainingRecoveryCodes(storedJson: string): number {
  try {
    const parsed = JSON.parse(storedJson || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === 'string' && x.length > 0).length
      : 0;
  } catch {
    return 0;
  }
}

export function verifyAndConsumeRecoveryCode(
  inputCode: string,
  storedJson: string
): {
  matched: boolean;
  remainingJson: string;
  remainingCount: number;
} {
  let storedList: string[] = [];
  try {
    const parsed = JSON.parse(storedJson || '[]');
    if (Array.isArray(parsed)) {
      storedList = parsed.filter(
        (x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x)
      );
    }
  } catch {
    storedList = [];
  }

  const normalized = String(inputCode || '')
    .replace(/[\s-]+/g, '')
    .toUpperCase();

  if (!/^[A-Z0-9]{8}$/.test(normalized) || storedList.length === 0) {
    return {
      matched: false,
      remainingJson: JSON.stringify(storedList),
      remainingCount: storedList.length,
    };
  }

  const candidateBuf = Buffer.from(
    hashRecoveryCodeNormalized(normalized),
    'hex'
  );

  let matchedIdx = -1;
  for (let i = 0; i < storedList.length; i++) {
    const itemBuf = Buffer.from(storedList[i], 'hex');
    if (
      itemBuf.length === candidateBuf.length &&
      crypto.timingSafeEqual(itemBuf, candidateBuf)
    ) {
      matchedIdx = i;
      break;
    }
  }

  if (matchedIdx === -1) {
    return {
      matched: false,
      remainingJson: JSON.stringify(storedList),
      remainingCount: storedList.length,
    };
  }

  const remaining = storedList.filter((_, idx) => idx !== matchedIdx);
  return {
    matched: true,
    remainingJson: JSON.stringify(remaining),
    remainingCount: remaining.length,
  };
}

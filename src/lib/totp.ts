import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb, type SqliteDatabase } from './db';
import { ensureJwtSecret } from './jwt-secret';
import { renderQrSvg } from './qr-svg';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 ký tự rõ ràng, không gây nhầm lẫn 0/O/1/I
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

let cachedDedicatedTotpKey: { dir: string; envVal: string; key: Buffer } | null =
  null;

export function resetTotpKeyCacheForTests(): void {
  cachedDedicatedTotpKey = null;
}

/**
 * Khóa mã hóa riêng cho 2FA TOTP & Recovery Codes (`v2:`), tách biệt hoàn toàn với `JWT_SECRET`
 * để khi xoay vòng `JWT_SECRET` (đăng xuất toàn bộ phiên) không làm hỏng khóa 2FA của quản trị viên.
 * A14 Security Fix: Nếu tệp `.totp_secret` đã tồn tại nhưng không đọc được hoặc bị hỏng (< 32 ký tự),
 * BẮT BUỘC fail-closed (throw Error) — tuyệt đối không tự ghi đè khóa mới hay sinh khóa ngẫu nhiên trong RAM.
 */
function getDedicatedTotpKey(): Buffer {
  const envVal = (process.env.TOTP_ENCRYPTION_KEY || '').trim();
  const dataDir = getDataDir();
  if (
    cachedDedicatedTotpKey &&
    cachedDedicatedTotpKey.dir === dataDir &&
    cachedDedicatedTotpKey.envVal === envVal
  ) {
    return cachedDedicatedTotpKey.key;
  }

  let rawSecret = '';
  if (envVal) {
    if (envVal.length < 32) {
      throw new Error(
        '[SECURITY] Biến môi trường TOTP_ENCRYPTION_KEY phải có độ dài tối thiểu 32 ký tự.'
      );
    }
    rawSecret = envVal;
  } else {
    const secretFile = path.join(dataDir, '.totp_secret');
    let createdNew = false;

    if (!fs.existsSync(secretFile)) {
      const generated = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(secretFile, `${generated}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
        rawSecret = generated;
        createdNew = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error(
            `[SECURITY] Không thể khởi tạo tệp khóa bảo mật 2FA (${secretFile}): ${
              (err as Error).message
            }`,
            { cause: err }
          );
        }
      }
    }

    if (!createdNew) {
      let existing: string;
      try {
        existing = fs.readFileSync(secretFile, 'utf8').trim();
      } catch (err) {
        throw new Error(
          `[SECURITY] Không thể đọc tệp khóa bảo mật 2FA hiện có (${secretFile}) — từ chối sinh khóa tạm thời để bảo vệ dữ liệu 2FA: ${
            (err as Error).message
          }`,
          { cause: err }
        );
      }

      if (existing.length < 32) {
        throw new Error(
          `[SECURITY] Tệp khóa bảo mật 2FA (${secretFile}) bị hỏng hoặc ngắn hơn 32 ký tự — từ chối ghi đè tự động (fail-closed).`
        );
      }
      rawSecret = existing;
    } else if (process.platform !== 'win32') {
      try {
        fs.chmodSync(secretFile, 0o600);
      } catch {
        // Ignore RichACL warning on NAS mounts
      }
    }
  }

  const key = crypto
    .createHash('sha256')
    .update('nas-sync-totp-v2:' + rawSecret)
    .digest();
  cachedDedicatedTotpKey = { dir: dataDir, envVal, key };
  return key;
}

/**
 * Khóa dẫn xuất thế hệ cũ (`v1:`) từ `JWT_SECRET` — chỉ giữ để giải mã tương thích ngược.
 */
function getLegacyTotpDerivedKey(): Buffer {
  if (!process.env.JWT_SECRET) {
    ensureJwtSecret();
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET chưa sẵn sàng để giải mã khóa 2FA cũ.');
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
  const key = getDedicatedTotpKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainBase32Secret, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `v2:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptTotpSecret(encryptedPayload: string): string {
  const parts = String(encryptedPayload || '').split(':');
  if (parts.length !== 4 || (parts[0] !== 'v2' && parts[0] !== 'v1')) {
    throw new Error('Định dạng khóa 2FA đã mã hóa không hợp lệ.');
  }
  const version = parts[0];
  const iv = Buffer.from(parts[1], 'hex');
  const authTag = Buffer.from(parts[2], 'hex');
  const ciphertext = Buffer.from(parts[3], 'hex');
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Metadata giải mã khóa 2FA không hợp lệ.');
  }
  const key =
    version === 'v2' ? getDedicatedTotpKey() : getLegacyTotpDerivedKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * A5 Fix: Tự động nâng cấp toàn bộ khóa 2FA thế hệ cũ (`v1:` phụ thuộc `JWT_SECRET`) sang `v2:` (khóa `.totp_secret` độc lập)
 * ngay khi CSDL khởi động, giúp việc xoay vòng `JWT_SECRET` về sau không làm khóa tài khoản quản trị viên chưa kịp đăng nhập.
 */
export function migrateLegacyV1TotpSecrets(db: SqliteDatabase): number {
  let migrated = 0;
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT id, totp_secret, totp_pending_secret
         FROM users
         WHERE totp_secret LIKE 'v1:%' OR totp_pending_secret LIKE 'v1:%'`
      )
      .all();
  } catch {
    return 0;
  }

  for (const row of rows) {
    const userId = Number(row.id);
    const curSecret =
      typeof row.totp_secret === 'string' ? row.totp_secret : null;
    const curPending =
      typeof row.totp_pending_secret === 'string'
        ? row.totp_pending_secret
        : null;

    let nextSecret = curSecret;
    let nextPending = curPending;
    let changed = false;

    try {
      if (curSecret && curSecret.startsWith('v1:')) {
        nextSecret = encryptTotpSecret(decryptTotpSecret(curSecret));
        changed = true;
      }
      if (curPending && curPending.startsWith('v1:')) {
        nextPending = encryptTotpSecret(decryptTotpSecret(curPending));
        changed = true;
      }
      if (changed) {
        db.prepare(
          'UPDATE users SET totp_secret = ?, totp_pending_secret = ? WHERE id = ?'
        ).run(nextSecret, nextPending, userId);
        migrated += 1;
      }
    } catch (err) {
      console.warn(
        `[TOTP Migration] Không thể chuyển đổi khóa 2FA v1 cho user #${userId}: ${
          (err as Error).message
        }`
      );
    }
  }
  return migrated;
}

function computeHotp(
  secretBytes: Buffer,
  counter: bigint,
  digits = TOTP_DIGITS
): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = crypto
    .createHmac('sha1', secretBytes)
    .update(counterBuf)
    .digest();
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
 * Xác thực mã TOTP 6 chữ số kèm trả về chỉ số chu kỳ `matchedStep` để chống phát lại (anti-replay RFC 6238 §5.2).
 */
export function verifyTotpCodeWithStep(
  base32Secret: string,
  inputCode: string,
  timestampMs = Date.now(),
  window = 1
): { valid: boolean; matchedStep: number | null } {
  const cleaned = String(inputCode || '').replace(/[\s-]+/g, '');
  if (!/^\d{6}$/.test(cleaned)) {
    return { valid: false, matchedStep: null };
  }

  let secretBytes: Buffer;
  try {
    secretBytes = decodeBase32(base32Secret);
  } catch {
    return { valid: false, matchedStep: null };
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
      return { valid: true, matchedStep: Number(step) };
    }
  }

  return { valid: false, matchedStep: null };
}

/**
 * Xác thực mã TOTP 6 chữ số theo chuẩn RFC 6238 (HMAC-SHA1, chu kỳ 30 giây).
 */
export function verifyTotpCode(
  base32Secret: string,
  inputCode: string,
  timestampMs = Date.now(),
  window = 1
): boolean {
  return verifyTotpCodeWithStep(base32Secret, inputCode, timestampMs, window)
    .valid;
}

/**
 * Ghi nhận nguyên tử chu kỳ TOTP vừa dùng của người dùng để chặn tấn công phát lại (Replay Attack) trong cửa sổ ±30s.
 */
export function consumeTotpStepAtomically(
  userId: number,
  matchedStep: number
): boolean {
  if (!Number.isInteger(userId) || userId <= 0 || matchedStep <= 0) {
    return false;
  }
  const res = getDb()
    .prepare(
      `UPDATE users
       SET totp_last_used_step = ?
       WHERE id = ? AND COALESCE(totp_last_used_step, 0) < ?`
    )
    .run(matchedStep, userId, matchedStep);
  return Number(res.changes) === 1;
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

function hashRecoveryCodeV2(normalizedCode: string): string {
  return crypto
    .createHmac('sha256', getDedicatedTotpKey())
    .update('recovery-v2:' + normalizedCode)
    .digest('hex');
}

function hashRecoveryCodeLegacyV1(normalizedCode: string): string {
  return crypto
    .createHmac('sha256', getLegacyTotpDerivedKey())
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
    hashedCodes.push(`v2:${hashRecoveryCodeV2(chars)}`);
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
        (x): x is string =>
          typeof x === 'string' &&
          (/^[0-9a-f]{64}$/i.test(x) || /^v2:[0-9a-f]{64}$/i.test(x))
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

  const candidateV2Buf = Buffer.from(hashRecoveryCodeV2(normalized), 'hex');
  let candidateLegacyBuf: Buffer | null = null;

  let matchedIdx = -1;
  for (let i = 0; i < storedList.length; i++) {
    const entry = storedList[i];
    if (entry.startsWith('v2:')) {
      const itemBuf = Buffer.from(entry.slice(3), 'hex');
      if (
        itemBuf.length === candidateV2Buf.length &&
        crypto.timingSafeEqual(itemBuf, candidateV2Buf)
      ) {
        matchedIdx = i;
        break;
      }
    } else {
      if (!candidateLegacyBuf) {
        candidateLegacyBuf = Buffer.from(
          hashRecoveryCodeLegacyV1(normalized),
          'hex'
        );
      }
      const itemBuf = Buffer.from(entry, 'hex');
      if (
        itemBuf.length === candidateLegacyBuf.length &&
        crypto.timingSafeEqual(itemBuf, candidateLegacyBuf)
      ) {
        matchedIdx = i;
        break;
      }
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

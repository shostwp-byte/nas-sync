import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './db';

// Mã băm SHA-256 của các giá trị mẫu từng xuất hiện công khai — coi như KHÔNG bí mật
const KNOWN_PUBLIC_SECRET_HASHES = new Set([
  '4054e3ab738be4a1e26ce88d728935bd3f5c3640c9957d906f32933e4313da12',
  '34feeb78b750604b4f6bbc9954e038c3943545c3824168651feda8f992b16fe5',
  '5c6ec3c115c735a80c4095a35864bf437975792c4d264e7db1b9681e92a15791',
]);

const MIN_SECRET_LENGTH = 32;

function isKnownSampleSecret(val: string): boolean {
  const digest = crypto.createHash('sha256').update(val).digest('hex');
  return KNOWN_PUBLIC_SECRET_HASHES.has(digest);
}

/**
 * Đảm bảo process.env.JWT_SECRET là chuỗi bí mật mạnh trước khi Next.js khởi động.
 * Nếu biến môi trường trống / quá ngắn / trùng giá trị mẫu công khai, tự sinh khóa ngẫu nhiên
 * và lưu bền vững tại DATA_DIR/.jwt_secret (quyền 0600) để phiên đăng nhập không mất sau khi restart.
 * Middleware Edge đọc process.env lúc tạo sandbox nên phải gọi hàm này TRƯỚC app.prepare().
 */
export function ensureJwtSecret(): void {
  const fromEnv = (process.env.JWT_SECRET || '').trim();
  if (fromEnv.length >= MIN_SECRET_LENGTH && !isKnownSampleSecret(fromEnv)) {
    return;
  }

  if (fromEnv) {
    console.warn(
      '[NAS-Sync Security] JWT_SECRET đang dùng giá trị mẫu công khai hoặc quá ngắn — bỏ qua và dùng khóa tự sinh trong DATA_DIR.'
    );
  }

  const secretFile = path.join(getDataDir(), '.jwt_secret');
  let secret = '';
  try {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    // Chưa có file — sẽ sinh mới bên dưới
  }

  if (secret.length < MIN_SECRET_LENGTH) {
    secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, secret + '\n', { mode: 0o600 });
    console.log(`[NAS-Sync Security] Đã sinh JWT secret ngẫu nhiên tại ${secretFile}`);
  }

  process.env.JWT_SECRET = secret;
}

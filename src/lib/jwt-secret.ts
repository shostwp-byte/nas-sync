import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './db';

// Các giá trị mẫu từng được phát hành công khai trong repo — coi như KHÔNG bí mật
const KNOWN_PUBLIC_SECRETS = new Set([
  'nas-sync-open-source-change-this-secret-2026',
  'please-change-this-to-a-random-64-character-secret-string',
  'shost-backup-enterprise-secret-change-me-2026',
]);

const MIN_SECRET_LENGTH = 32;

/**
 * Đảm bảo process.env.JWT_SECRET là chuỗi bí mật mạnh trước khi Next.js khởi động.
 * Nếu biến môi trường trống / quá ngắn / trùng giá trị mẫu công khai, tự sinh khóa ngẫu nhiên
 * và lưu bền vững tại DATA_DIR/.jwt_secret (quyền 0600) để phiên đăng nhập không mất sau khi restart.
 * Middleware Edge đọc process.env lúc tạo sandbox nên phải gọi hàm này TRƯỚC app.prepare().
 */
export function ensureJwtSecret(): void {
  const fromEnv = (process.env.JWT_SECRET || '').trim();
  if (fromEnv.length >= MIN_SECRET_LENGTH && !KNOWN_PUBLIC_SECRETS.has(fromEnv)) {
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

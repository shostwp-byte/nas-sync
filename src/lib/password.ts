import crypto from 'node:crypto';

export const MAX_PASSWORD_LENGTH = 256;

export function hashPassword(password: string): string {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Mật khẩu không hợp lệ hoặc vượt quá ${MAX_PASSWORD_LENGTH} ký tự.`
    );
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  if (!password || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Mật khẩu không hợp lệ hoặc vượt quá ${MAX_PASSWORD_LENGTH} ký tự.`
    );
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(key);
    });
  });
  return `${salt}:${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!password || password.length > MAX_PASSWORD_LENGTH || !stored) {
    return false;
  }
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const hashBuffer = crypto.scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, 'hex');
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}

export async function verifyPasswordAsync(
  password: string,
  stored: string
): Promise<boolean> {
  if (!password || password.length > MAX_PASSWORD_LENGTH || !stored) {
    return false;
  }
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const keyBuffer = Buffer.from(key, 'hex');
  if (keyBuffer.length !== 64) return false;
  const hashBuffer = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derived);
    });
  });
  if (hashBuffer.length !== keyBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, keyBuffer);
}


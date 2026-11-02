import { SignJWT, jwtVerify } from 'jose';
import type { UserRole } from '@/types';

export const SESSION_COOKIE_NAME = 'nas_sync_session';

export interface SessionPayload {
  userId: number;
  username: string;
  role: UserRole;
  tokenVersion?: number;
}

export function normalizeUserRole(raw: unknown): UserRole {
  if (raw === 'ADMIN' || raw === 'OPERATOR' || raw === 'VIEWER') {
    return raw;
  }
  return 'VIEWER';
}

function getJwtSecret(): Uint8Array {
  // Không có giá trị mặc định cứng: server.ts gọi ensureJwtSecret() lúc khởi động.
  // Thiếu secret thì từ chối ký/xác thực (fail-closed) thay vì dùng khóa công khai.
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET chưa được cấu hình.');
  }
  return new TextEncoder().encode(secret);
}

export async function signSessionToken(payload: SessionPayload): Promise<string> {
  return await new SignJWT({
    userId: payload.userId,
    username: payload.username,
    role: payload.role,
    tokenVersion:
      typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 1,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(getJwtSecret());
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    if (!payload.username || typeof payload.userId !== 'number') {
      return null;
    }
    return {
      userId: payload.userId as number,
      username: payload.username as string,
      role: normalizeUserRole(payload.role ?? 'ADMIN'),
      tokenVersion:
        typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 1,
    };
  } catch {
    return null;
  }
}

export const signSessionJwt = signSessionToken;
export const verifySessionJwt = verifySessionToken;

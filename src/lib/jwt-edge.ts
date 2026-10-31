import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'nas_sync_session';

export interface SessionPayload {
  userId: number;
  username: string;
  role: string;
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
  return await new SignJWT({ ...payload })
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
      role: (payload.role as string) || 'ADMIN',
    };
  } catch {
    return null;
  }
}


import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  SessionPayload,
  signSessionToken,
  verifySessionToken,
} from './jwt-edge';
import { hashPassword, verifyPassword } from './password';

export {
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifySessionToken,
  hashPassword,
  verifyPassword,
  type SessionPayload,
};

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;

export async function getCurrentSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * Tùy chọn cookie phiên dùng chung cho login / đổi mật khẩu / logout.
 * Bật cờ Secure khi truy cập qua HTTPS (trực tiếp hoặc sau Synology Reverse Proxy / Cloudflare Tunnel),
 * vẫn cho phép HTTP thuần trong LAN.
 */
export function sessionCookieOptions(req: NextRequest, maxAge = SESSION_MAX_AGE_SECONDS) {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const isHttps = forwardedProto === 'https' || req.nextUrl.protocol === 'https:';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isHttps,
    path: '/',
    maxAge,
  };
}

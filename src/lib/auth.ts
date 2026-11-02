import { cookies } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import type { UserRole } from '@/types';
import { getDb } from './db';
import {
  SESSION_COOKIE_NAME,
  SessionPayload,
  normalizeUserRole,
  signSessionToken,
  verifySessionToken,
} from './jwt-edge';
import { hashPassword, verifyPassword } from './password';

export {
  SESSION_COOKIE_NAME,
  normalizeUserRole,
  signSessionToken,
  verifySessionToken,
  hashPassword,
  verifyPassword,
  type SessionPayload,
};

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;

export const VALID_USER_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ADMIN',
  'OPERATOR',
  'VIEWER',
]);

export function isValidUserRole(val: unknown): val is UserRole {
  return typeof val === 'string' && VALID_USER_ROLES.has(val as UserRole);
}

export function validateSessionAgainstDb(
  session: SessionPayload
): SessionPayload | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT id, username, role, COALESCE(token_version, 1) AS token_version FROM users WHERE id = ?'
      )
      .get(session.userId);
    if (!row) return null;
    const dbTokenVersion = Number(row.token_version ?? 1);
    if (dbTokenVersion !== (session.tokenVersion ?? 1)) {
      return null;
    }
    return {
      userId: Number(row.id),
      username: String(row.username),
      role: normalizeUserRole(row.role || 'ADMIN'),
      tokenVersion: dbTokenVersion,
    };
  } catch {
    return null;
  }
}

export async function getCurrentSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  if (!session) return null;
  return validateSessionAgainstDb(session);
}

export async function requireRole(
  allowedRoles: readonly UserRole[],
  customForbiddenError?: string
): Promise<
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn.' },
        { status: 401 }
      ),
    };
  }

  if (!allowedRoles.includes(session.role)) {
    const defaultMsg =
      allowedRoles.length === 1 && allowedRoles[0] === 'ADMIN'
        ? 'Thao tác này yêu cầu quyền Quản trị viên (ADMIN).'
        : 'Tài khoản của bạn không có quyền thực hiện thao tác này.';
    return {
      ok: false,
      response: NextResponse.json(
        { error: customForbiddenError || defaultMsg },
        { status: 403 }
      ),
    };
  }

  return { ok: true, session };
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

import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  signSessionToken,
  verifyPassword,
} from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  clearLoginFailures,
  getLoginLockSeconds,
  recordLoginFailure,
} from '@/lib/login-throttle';

function getClientIp(req: NextRequest): string {
  const socketIp = req.headers.get('x-nas-client-ip')?.trim() || '';
  if (process.env.TRUST_PROXY === 'true') {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const hops = xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (hops.length > 0) {
        return hops[hops.length - 1];
      }
    }
    const realIp = req.headers.get('x-real-ip')?.trim();
    if (realIp) return realIp;
  }
  return socketIp || 'local-client';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu.' },
        { status: 400 }
      );
    }

    if (username.length > 64 || password.length > 256) {
      return NextResponse.json(
        { error: 'Tên đăng nhập hoặc mật khẩu vượt quá độ dài cho phép.' },
        { status: 400 }
      );
    }

    const throttleKey = `${getClientIp(req)}|${username.toLowerCase()}`;
    const lockSeconds = getLoginLockSeconds(throttleKey);
    if (lockSeconds > 0) {
      return NextResponse.json(
        {
          error: `Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(
            lockSeconds / 60
          )} phút.`,
        },
        { status: 429, headers: { 'Retry-After': String(lockSeconds) } }
      );
    }

    const db = getDb();
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username);

    if (!user || !verifyPassword(password, String(user.password_hash))) {
      recordLoginFailure(throttleKey);
      return NextResponse.json(
        { error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' },
        { status: 401 }
      );
    }

    clearLoginFailures(throttleKey);

    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(
      Number(user.id)
    );

    const token = await signSessionToken({
      userId: Number(user.id),
      username: String(user.username),
      role: String(user.role || 'ADMIN'),
      tokenVersion: Number(user.token_version ?? 1),
    });

    const res = NextResponse.json({
      ok: true,
      user: {
        id: Number(user.id),
        username: String(user.username),
        role: String(user.role),
      },
    });

    res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


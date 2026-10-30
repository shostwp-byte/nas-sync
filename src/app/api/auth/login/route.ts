import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifyPassword,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

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

    const db = getDb();
    const user = db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username);

    if (!user || !verifyPassword(password, String(user.password_hash))) {
      return NextResponse.json(
        { error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' },
        { status: 401 }
      );
    }

    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(
      Number(user.id)
    );

    const token = await signSessionToken({
      userId: Number(user.id),
      username: String(user.username),
      role: String(user.role || 'ADMIN'),
    });

    const res = NextResponse.json({
      ok: true,
      user: {
        id: Number(user.id),
        username: String(user.username),
        role: String(user.role),
      },
    });

    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 3600,
    });

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


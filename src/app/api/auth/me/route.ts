import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  getCurrentSession,
  hashPassword,
  signSessionToken,
  verifyPassword,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ user: session });
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json(
        { error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawCurrentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '').trim();

    if (!rawCurrentPassword) {
      return NextResponse.json(
        { error: 'Vui lòng nhập mật khẩu hiện tại.' },
        { status: 400 }
      );
    }

    if (newPassword.length < 6) {
      return NextResponse.json(
        { error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' },
        { status: 400 }
      );
    }

    const db = getDb();
    let user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(session.userId);

    // Fallback tìm theo username nếu CSDL từng được khởi tạo lại trong khi trình duyệt còn giữ JWT cũ
    if (!user && session.username) {
      user = db
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(session.username);
    }

    if (!user) {
      return NextResponse.json(
        { error: 'Không tìm thấy tài khoản quản trị trong CSDL. Vui lòng đăng xuất và đăng nhập lại.' },
        { status: 400 }
      );
    }

    const storedHash = String(user.password_hash);
    const isMatch =
      verifyPassword(rawCurrentPassword, storedHash) ||
      (rawCurrentPassword !== rawCurrentPassword.trim() &&
        verifyPassword(rawCurrentPassword.trim(), storedHash));

    if (!isMatch) {
      return NextResponse.json(
        {
          error:
            'Mật khẩu hiện tại không đúng. (Lưu ý: Nếu bạn nâng cấp từ bản v1.0.0 và chưa từng đổi mật khẩu, mật khẩu gốc trong CSDL là "shost@2026").',
        },
        { status: 400 }
      );
    }

    const userId = Number(user.id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      hashPassword(newPassword),
      userId
    );

    const freshToken = await signSessionToken({
      userId,
      username: String(user.username),
      role: String(user.role || 'ADMIN'),
    });

    const res = NextResponse.json({
      ok: true,
      message: 'Đã cập nhật mật khẩu Admin thành công!',
    });

    res.cookies.set(SESSION_COOKIE_NAME, freshToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 3600,
    });

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Lỗi máy chủ khi đổi mật khẩu.' },
      { status: 500 }
    );
  }
}

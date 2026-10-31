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

  try {
    const db = getDb();
    const user =
      db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(session.userId) ||
      db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(session.username);

    if (user) {
      return NextResponse.json({
        user: {
          userId: Number(user.id),
          username: String(user.username),
          role: String(user.role || 'ADMIN'),
        },
      });
    }
  } catch {
    // Fallback session payload
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
    const rawNewUsername =
      body.newUsername !== undefined ? String(body.newUsername).trim() : '';
    const newPassword = String(body.newPassword || '').trim();

    if (!rawCurrentPassword) {
      return NextResponse.json(
        { error: 'Vui lòng nhập mật khẩu hiện tại để xác nhận.' },
        { status: 400 }
      );
    }

    const db = getDb();
    let user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(session.userId);

    // Fallback tìm theo username hoặc tài khoản ADMIN đầu tiên nếu JWT cũ lệch ID
    if (!user && session.username) {
      user = db
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(session.username);
    }
    if (!user) {
      user = db
        .prepare("SELECT * FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1")
        .get();
    }

    if (!user) {
      return NextResponse.json(
        {
          error:
            'Không tìm thấy tài khoản quản trị trong CSDL. Vui lòng đăng xuất và đăng nhập lại.',
        },
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
            'Mật khẩu hiện tại không đúng. (Lưu ý: Nếu nâng cấp từ v1.0.0 và chưa từng đổi mật khẩu, mật khẩu gốc là "shost@2026").',
        },
        { status: 400 }
      );
    }

    const userId = Number(user.id);
    const currentUsername = String(user.username);
    const targetUsername = rawNewUsername || currentUsername;
    const isChangingUsername = targetUsername !== currentUsername;
    const isChangingPassword = newPassword.length > 0;

    if (!isChangingUsername && !isChangingPassword) {
      return NextResponse.json(
        {
          error:
            'Vui lòng nhập Tên đăng nhập (Username) mới hoặc Mật khẩu mới cần thay đổi.',
        },
        { status: 400 }
      );
    }

    if (isChangingUsername) {
      if (targetUsername.length < 3 || targetUsername.length > 32) {
        return NextResponse.json(
          { error: 'Tên đăng nhập mới phải dài từ 3 đến 32 ký tự.' },
          { status: 400 }
        );
      }
      if (!/^[a-zA-Z0-9._@-]+$/.test(targetUsername)) {
        return NextResponse.json(
          {
            error:
              'Tên đăng nhập chỉ được chứa chữ cái không dấu, chữ số và các ký tự . _ @ - (không chứa khoảng trắng).',
          },
          { status: 400 }
        );
      }
      const duplicate = db
        .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
        .get(targetUsername, userId);
      if (duplicate) {
        return NextResponse.json(
          { error: `Tên đăng nhập "${targetUsername}" đã tồn tại.` },
          { status: 400 }
        );
      }
    }

    if (isChangingPassword && newPassword.length < 6) {
      return NextResponse.json(
        { error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' },
        { status: 400 }
      );
    }

    const nextHash = isChangingPassword ? hashPassword(newPassword) : storedHash;
    db.prepare(
      'UPDATE users SET username = ?, password_hash = ? WHERE id = ?'
    ).run(targetUsername, nextHash, userId);

    const freshToken = await signSessionToken({
      userId,
      username: targetUsername,
      role: String(user.role || 'ADMIN'),
    });

    const changedParts: string[] = [];
    if (isChangingUsername) {
      changedParts.push(`Username ➔ "${targetUsername}"`);
    }
    if (isChangingPassword) {
      changedParts.push('Mật khẩu mới');
    }

    const res = NextResponse.json({
      ok: true,
      username: targetUsername,
      message: `✅ Đã cập nhật thành công (${changedParts.join(' & ')})!`,
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
      { error: (err as Error).message || 'Lỗi máy chủ khi cập nhật tài khoản.' },
      { status: 500 }
    );
  }
}

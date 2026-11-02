import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  getCurrentSession,
  hashPassword,
  normalizeUserRole,
  sessionCookieOptions,
  signSessionToken,
  verifyPassword,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const row = getDb()
    .prepare('SELECT totp_enabled FROM users WHERE id = ?')
    .get(session.userId);

  return NextResponse.json({
    user: {
      userId: session.userId,
      username: session.username,
      role: session.role,
      totpEnabled: Boolean(row?.totp_enabled),
    },
  });
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
    const rawCurrentPassword =
      typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const rawNewUsername =
      body.newUsername !== undefined ? String(body.newUsername).trim() : '';
    const rawNewPassword =
      typeof body.newPassword === 'string' ? body.newPassword : '';

    if (!rawCurrentPassword) {
      return NextResponse.json(
        { error: 'Vui lòng nhập mật khẩu hiện tại để xác nhận.' },
        { status: 400 }
      );
    }

    if (rawCurrentPassword.length > 256) {
      return NextResponse.json(
        { error: 'Mật khẩu hiện tại không đúng. Vui lòng kiểm tra lại.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(session.userId);

    if (!user) {
      return NextResponse.json(
        {
          error:
            'Không tìm thấy tài khoản trong CSDL. Vui lòng đăng xuất và đăng nhập lại.',
        },
        { status: 401 }
      );
    }

    const storedHash = String(user.password_hash);
    const isMatch = verifyPassword(rawCurrentPassword, storedHash);

    if (!isMatch) {
      return NextResponse.json(
        {
          error: 'Mật khẩu hiện tại không đúng. Vui lòng kiểm tra lại.',
        },
        { status: 400 }
      );
    }

    const userId = Number(user.id);
    const currentUsername = String(user.username);
    const targetUsername = rawNewUsername || currentUsername;
    const isChangingUsername = targetUsername !== currentUsername;
    const isChangingPassword = rawNewPassword.trim().length > 0;

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

    if (
      isChangingPassword &&
      (rawNewPassword.length < 8 || rawNewPassword.length > 256)
    ) {
      return NextResponse.json(
        { error: 'Mật khẩu mới phải có độ dài từ 8 đến 256 ký tự.' },
        { status: 400 }
      );
    }

    const currentTokenVersion = Number(user.token_version ?? 1);
    const nextTokenVersion = isChangingPassword
      ? currentTokenVersion + 1
      : currentTokenVersion;
    const nextHash = isChangingPassword
      ? hashPassword(rawNewPassword)
      : storedHash;
    const userRole = normalizeUserRole(user.role || 'ADMIN');

    db.prepare(
      'UPDATE users SET username = ?, password_hash = ?, token_version = ? WHERE id = ?'
    ).run(targetUsername, nextHash, nextTokenVersion, userId);

    const freshToken = await signSessionToken({
      userId,
      username: targetUsername,
      role: userRole,
      tokenVersion: nextTokenVersion,
    });

    const changedParts: string[] = [];
    if (isChangingUsername) {
      changedParts.push(`Username ➔ "${targetUsername}"`);
    }
    if (isChangingPassword) {
      changedParts.push('Mật khẩu mới');
    }

    recordAuditLog({
      userId,
      username: targetUsername,
      action: 'USER_SELF_UPDATE',
      resourceType: 'USER',
      resourceId: String(userId),
      detail: `Cập nhật thông tin cá nhân (${changedParts.join(' & ')})`,
      req,
    });

    const res = NextResponse.json({
      ok: true,
      username: targetUsername,
      message: `✅ Đã cập nhật thành công (${changedParts.join(' & ')})!`,
    });

    res.cookies.set(SESSION_COOKIE_NAME, freshToken, sessionCookieOptions(req));

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Lỗi máy chủ khi cập nhật tài khoản.' },
      { status: 500 }
    );
  }
}

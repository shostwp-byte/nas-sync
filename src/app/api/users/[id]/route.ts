import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  hashPassword,
  isValidUserRole,
  normalizeUserRole,
  requireRole,
  sessionCookieOptions,
  signSessionToken,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const targetId = Number(id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return NextResponse.json(
        { error: 'ID tài khoản không hợp lệ.' },
        { status: 400 }
      );
    }

    const body = await req.json();
    const db = getDb();
    const targetUser = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(targetId);

    if (!targetUser) {
      return NextResponse.json(
        { error: 'Không tìm thấy tài khoản người dùng.' },
        { status: 404 }
      );
    }

    const currentRole = normalizeUserRole(targetUser.role || 'ADMIN');
    let nextRole = currentRole;

    if (body.role !== undefined) {
      const requestedRole = String(body.role).trim().toUpperCase();
      if (!isValidUserRole(requestedRole)) {
        return NextResponse.json(
          { error: 'Vai trò không hợp lệ (chỉ chấp nhận ADMIN, OPERATOR, VIEWER).' },
          { status: 400 }
        );
      }

      if (currentRole === 'ADMIN' && requestedRole !== 'ADMIN') {
        if (targetId === guard.session.userId) {
          return NextResponse.json(
            { error: 'Không thể tự hạ quyền Quản trị viên (ADMIN) của chính bạn.' },
            { status: 400 }
          );
        }

        const adminCount = Number(
          db
            .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN'")
            .get()?.cnt || 0
        );
        if (adminCount <= 1) {
          return NextResponse.json(
            {
              error:
                'Không thể hạ quyền Quản trị viên (ADMIN) cuối cùng của hệ thống.',
            },
            { status: 400 }
          );
        }
      }
      nextRole = requestedRole;
    }

    const rawNewPassword =
      typeof body.password === 'string'
        ? body.password
        : typeof body.newPassword === 'string'
        ? body.newPassword
        : '';

    let nextPasswordHash = String(targetUser.password_hash);
    const passwordChanged = rawNewPassword.length > 0;
    if (passwordChanged) {
      if (rawNewPassword.length < 8 || rawNewPassword.length > 256) {
        return NextResponse.json(
          { error: 'Mật khẩu mới phải có độ dài từ 8 đến 256 ký tự.' },
          { status: 400 }
        );
      }
      nextPasswordHash = hashPassword(rawNewPassword);
    }

    const shouldReset2fa =
      body.reset2fa === true ||
      body.disable2fa === true ||
      body.totp_enabled === 0 ||
      body.totpEnabled === false;

    const roleChanged = nextRole !== currentRole;
    if (!roleChanged && !passwordChanged && !shouldReset2fa) {
      return NextResponse.json(
        { error: 'Không có thay đổi nào được gửi lên.' },
        { status: 400 }
      );
    }

    const nextTokenVersion = Number(targetUser.token_version ?? 1) + 1;

    if (shouldReset2fa) {
      db.prepare(
        `UPDATE users
         SET role = ?,
             password_hash = ?,
             totp_enabled = 0,
             totp_secret = NULL,
             totp_pending_secret = NULL,
             recovery_codes_json = '[]',
             token_version = ?
         WHERE id = ?`
      ).run(nextRole, nextPasswordHash, nextTokenVersion, targetId);
    } else {
      db.prepare(
        `UPDATE users
         SET role = ?,
             password_hash = ?,
             token_version = ?
         WHERE id = ?`
      ).run(nextRole, nextPasswordHash, nextTokenVersion, targetId);
    }

    const detailParts: string[] = [];
    if (roleChanged) detailParts.push(`vai trò ${currentRole} ➔ ${nextRole}`);
    if (passwordChanged) detailParts.push('đặt lại mật khẩu');
    if (shouldReset2fa) detailParts.push('gỡ khóa 2FA');

    recordAuditLog({
      session: guard.session,
      action: 'USER_UPDATE',
      resourceType: 'USER',
      resourceId: String(targetId),
      detail: `Cập nhật tài khoản "${targetUser.username}": ${detailParts.join(
        ', '
      )}`,
      req,
    });

    const res = NextResponse.json({ ok: true });
    if (targetId === guard.session.userId) {
      const freshToken = await signSessionToken({
        userId: targetId,
        username: String(targetUser.username),
        role: nextRole,
        tokenVersion: nextTokenVersion,
      });
      res.cookies.set(SESSION_COOKIE_NAME, freshToken, sessionCookieOptions(req));
    }

    return res;
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const targetId = Number(id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return NextResponse.json(
        { error: 'ID tài khoản không hợp lệ.' },
        { status: 400 }
      );
    }

    if (targetId === guard.session.userId) {
      return NextResponse.json(
        { error: 'Không thể tự xóa tài khoản đang đăng nhập của chính bạn.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const targetUser = db
      .prepare('SELECT id, username, role FROM users WHERE id = ?')
      .get(targetId);

    if (!targetUser) {
      return NextResponse.json(
        { error: 'Không tìm thấy tài khoản cần xóa.' },
        { status: 404 }
      );
    }

    if (String(targetUser.role) === 'ADMIN') {
      const adminCount = Number(
        db
          .prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN'")
          .get()?.cnt || 0
      );
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'Không thể xóa Quản trị viên (ADMIN) cuối cùng của hệ thống.' },
          { status: 400 }
        );
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

    recordAuditLog({
      session: guard.session,
      action: 'USER_DELETE',
      resourceType: 'USER',
      resourceId: String(targetId),
      detail: `Xóa tài khoản "${targetUser.username}" (${targetUser.role})`,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

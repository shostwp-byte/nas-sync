import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  hashPasswordAsync,
  isValidUserRole,
  normalizeUserRole,
  requireRole,
  sessionCookieOptions,
  signSessionToken,
  verifyPasswordAsync,
} from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  clearLoginFailures,
  getLoginLockSeconds,
  recordLoginFailure,
} from '@/lib/login-throttle';
import {
  consumeTotpStepAtomically,
  decryptTotpSecret,
  verifyAndConsumeRecoveryCode,
  verifyTotpCodeWithStep,
} from '@/lib/totp';

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

    const passwordChanged = rawNewPassword.length > 0;
    const shouldReset2fa =
      body.reset2fa === true ||
      body.disable2fa === true ||
      body.resetTotp === true ||
      body.totp_enabled === 0 ||
      body.totpEnabled === false;

    const roleChanged = nextRole !== currentRole;
    if (!roleChanged && !passwordChanged && !shouldReset2fa) {
      return NextResponse.json(
        { error: 'Không có thay đổi nào được gửi lên.' },
        { status: 400 }
      );
    }

    // A9 Security Fix:
    // 1. Cấm tự đổi mật khẩu / tự gỡ 2FA của chính mình qua API quản trị RBAC (phải dùng Tab Tài khoản cá nhân để kiểm tra mật khẩu + TOTP).
    // 2. Bắt buộc xác thực lại mật khẩu hiện tại (và mã 2FA nếu ADMIN đang bật 2FA) trước khi đặt lại mật khẩu hoặc gỡ 2FA của người dùng khác.
    if (passwordChanged || shouldReset2fa) {
      if (targetId === guard.session.userId) {
        return NextResponse.json(
          {
            error:
              'Không được tự đặt lại mật khẩu hoặc gỡ 2FA của chính bạn qua mục Quản trị RBAC. Vui lòng sử dụng mục Tài khoản & Bảo mật 2FA cá nhân.',
          },
          { status: 400 }
        );
      }

      const reauthKey = `reauth:${guard.session.userId}`;
      const lockSeconds = getLoginLockSeconds(reauthKey);
      if (lockSeconds > 0) {
        return NextResponse.json(
          {
            error: `Xác thực quản trị sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(
              lockSeconds / 60
            )} phút.`,
          },
          { status: 429, headers: { 'Retry-After': String(lockSeconds) } }
        );
      }

      const actingAdmin = db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(guard.session.userId);
      if (!actingAdmin) {
        return NextResponse.json(
          { error: 'Phiên quản trị không hợp lệ.' },
          { status: 401 }
        );
      }

      const rawAdminPassword =
        typeof body.adminPassword === 'string'
          ? body.adminPassword
          : typeof body.currentAdminPassword === 'string'
          ? body.currentAdminPassword
          : '';
      if (
        !rawAdminPassword ||
        !(await verifyPasswordAsync(
          rawAdminPassword,
          String(actingAdmin.password_hash)
        ))
      ) {
        recordLoginFailure(reauthKey);
        recordAuditLog({
          session: guard.session,
          action: 'USER_REAUTH_FAILED',
          resourceType: 'USER',
          resourceId: String(targetId),
          detail: `Xác thực mật khẩu ADMIN thất bại khi cố đặt lại thông tin bảo mật cho "${targetUser.username}"`,
          req,
        });
        return NextResponse.json(
          {
            error:
              'Vui lòng nhập chính xác mật khẩu Quản trị viên (ADMIN) hiện tại để xác nhận thao tác nhạy cảm này.',
          },
          { status: 403 }
        );
      }

      if (Number(actingAdmin.totp_enabled) === 1 && actingAdmin.totp_secret) {
        const rawAdminCode = String(
          body.adminTotpCode ?? body.totpCode ?? body.code ?? ''
        ).trim();
        if (!rawAdminCode) {
          return NextResponse.json(
            {
              error:
                'Tài khoản ADMIN của bạn đang bật 2FA — vui lòng nhập kèm mã xác thực 6 chữ số (hoặc Mã khôi phục) để xác nhận.',
            },
            { status: 403 }
          );
        }

        const adminPlainSecret = decryptTotpSecret(
          String(actingAdmin.totp_secret)
        );
        const stepCheck = verifyTotpCodeWithStep(
          adminPlainSecret,
          rawAdminCode
        );
        const validTotp =
          stepCheck.valid &&
          stepCheck.matchedStep !== null &&
          consumeTotpStepAtomically(
            guard.session.userId,
            stepCheck.matchedStep
          );
        let validRecovery = false;
        if (!validTotp) {
          const recCheck = verifyAndConsumeRecoveryCode(
            rawAdminCode,
            String(actingAdmin.recovery_codes_json || '[]')
          );
          if (recCheck.matched) {
            validRecovery = true;
            db.prepare(
              'UPDATE users SET recovery_codes_json = ? WHERE id = ?'
            ).run(recCheck.remainingJson, guard.session.userId);
          }
        }

        if (!validTotp && !validRecovery) {
          recordLoginFailure(reauthKey);
          return NextResponse.json(
            {
              error:
                'Mã xác thực 2FA của Quản trị viên không chính xác hoặc vừa được sử dụng.',
            },
            { status: 403 }
          );
        }
      }

      clearLoginFailures(reauthKey);
    }

    let nextPasswordHash = String(targetUser.password_hash);
    if (passwordChanged) {
      if (rawNewPassword.length < 8 || rawNewPassword.length > 256) {
        return NextResponse.json(
          { error: 'Mật khẩu mới phải có độ dài từ 8 đến 256 ký tự.' },
          { status: 400 }
        );
      }
      nextPasswordHash = await hashPasswordAsync(rawNewPassword);
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
    return safeErrorJson(err, 'Không thể cập nhật tài khoản người dùng.', 500);
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
    return safeErrorJson(err, 'Không thể cập nhật tài khoản người dùng.', 500);
  }
}

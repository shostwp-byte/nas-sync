import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  getCurrentSession,
  normalizeUserRole,
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
  buildOtpAuthUrl,
  consumeTotpStepAtomically,
  countRemainingRecoveryCodes,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpQrSvg,
  generateTotpSecret,
  verifyAndConsumeRecoveryCode,
  verifyTotpCodeWithStep,
} from '@/lib/totp';

export async function GET() {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json(
        { error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn.' },
        { status: 401 }
      );
    }

    const row = getDb()
      .prepare(
        'SELECT totp_enabled, totp_pending_secret, recovery_codes_json FROM users WHERE id = ?'
      )
      .get(session.userId);

    const enabled = Boolean(row?.totp_enabled);
    const remaining = countRemainingRecoveryCodes(
      String(row?.recovery_codes_json || '[]')
    );

    return NextResponse.json({
      ok: true,
      enabled,
      totpEnabled: enabled,
      hasPendingSetup: Boolean(row?.totp_pending_secret),
      recoveryCodesRemaining: remaining,
      remainingRecoveryCodes: remaining,
      recoveryCodesCount: remaining,
    });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải trạng thái 2FA.', 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json(
        { error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn.' },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const db = getDb();
    const user = db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(session.userId);

    if (!user) {
      return NextResponse.json(
        { error: 'Không tìm thấy tài khoản trong CSDL.' },
        { status: 404 }
      );
    }

    const userId = Number(user.id);
    const username = String(user.username);
    const reauthKey = `reauth:${userId}`;
    const lockSeconds = getLoginLockSeconds(reauthKey);
    if (lockSeconds > 0) {
      return NextResponse.json(
        {
          error: `Xác thực sai quá nhiều lần. Vui lòng thử lại sau ${Math.ceil(
            lockSeconds / 60
          )} phút.`,
        },
        { status: 429, headers: { 'Retry-After': String(lockSeconds) } }
      );
    }

    if (action === 'setup') {
      if (Number(user.totp_enabled) === 1) {
        return NextResponse.json(
          { error: 'Xác thực 2 lớp (2FA) đang được bật trên tài khoản này.' },
          { status: 400 }
        );
      }

      const rawPassword =
        typeof body.currentPassword === 'string'
          ? body.currentPassword
          : typeof body.password === 'string'
          ? body.password
          : '';
      if (
        !rawPassword ||
        !(await verifyPasswordAsync(rawPassword, String(user.password_hash)))
      ) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          { error: 'Mật khẩu hiện tại không chính xác. Vui lòng kiểm tra lại.' },
          { status: 400 }
        );
      }
      clearLoginFailures(reauthKey);

      const secret = generateTotpSecret();
      const encryptedPending = encryptTotpSecret(secret);
      const otpauthUrl = buildOtpAuthUrl(username, secret);
      const qrSvg = await generateTotpQrSvg(otpauthUrl);

      db.prepare(
        'UPDATE users SET totp_pending_secret = ? WHERE id = ?'
      ).run(encryptedPending, userId);

      return NextResponse.json({
        ok: true,
        secret,
        manualKey: secret,
        otpauthUrl,
        qrSvg,
        qrCodeSvg: qrSvg,
      });
    }

    if (action === 'enable') {
      const code = String(
        body.code ?? body.totpCode ?? body.token ?? ''
      ).trim();
      const rawPassword =
        typeof body.currentPassword === 'string'
          ? body.currentPassword
          : typeof body.password === 'string'
          ? body.password
          : '';

      if (
        rawPassword &&
        !(await verifyPasswordAsync(rawPassword, String(user.password_hash)))
      ) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          { error: 'Mật khẩu hiện tại không chính xác.' },
          { status: 400 }
        );
      }

      if (!user.totp_pending_secret) {
        return NextResponse.json(
          {
            error:
              'Chưa có khóa thiết lập 2FA tạm thời. Vui lòng bấm Thiết lập 2FA để tạo mã QR mới.',
          },
          { status: 400 }
        );
      }

      if (!code) {
        return NextResponse.json(
          { error: 'Vui lòng nhập mã xác thực 6 chữ số từ ứng dụng Authenticator.' },
          { status: 400 }
        );
      }

      const pendingPlainSecret = decryptTotpSecret(
        String(user.totp_pending_secret)
      );
      const stepCheck = verifyTotpCodeWithStep(pendingPlainSecret, code);
      if (!stepCheck.valid || stepCheck.matchedStep === null) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          {
            error:
              'Mã xác thực 6 chữ số không chính xác hoặc đã hết hạn. Vui lòng kiểm tra giờ hệ thống trên thiết bị.',
          },
          { status: 400 }
        );
      }
      clearLoginFailures(reauthKey);

      const { plainCodes, hashedJson } = generateRecoveryCodes(8);
      const encryptedActive = encryptTotpSecret(pendingPlainSecret);
      const nextTokenVersion = Number(user.token_version ?? 1) + 1;

      db.prepare(
        `UPDATE users
         SET totp_secret = ?,
             totp_pending_secret = NULL,
             totp_enabled = 1,
             totp_last_used_step = ?,
             recovery_codes_json = ?,
             token_version = ?
         WHERE id = ?`
      ).run(
        encryptedActive,
        stepCheck.matchedStep,
        hashedJson,
        nextTokenVersion,
        userId
      );

      const freshToken = await signSessionToken({
        userId,
        username,
        role: normalizeUserRole(user.role || 'ADMIN'),
        tokenVersion: nextTokenVersion,
      });

      recordAuditLog({
        session,
        action: 'AUTH_2FA_ENABLED',
        resourceType: 'USER',
        resourceId: String(userId),
        detail:
          'Đã kích hoạt bảo mật 2 lớp (2FA TOTP), xoay vòng phiên đăng nhập và khởi tạo 8 mã khôi phục',
        req,
      });

      const res = NextResponse.json({
        ok: true,
        enabled: true,
        totpEnabled: true,
        recoveryCodes: plainCodes,
        recoveryCodesRemaining: plainCodes.length,
        remainingRecoveryCodes: plainCodes.length,
        message: 'Đã kích hoạt xác thực 2 lớp (2FA TOTP) thành công!',
      });
      res.cookies.set(SESSION_COOKIE_NAME, freshToken, sessionCookieOptions(req));
      return res;
    }

    if (action === 'disable') {
      if (Number(user.totp_enabled) !== 1) {
        return NextResponse.json(
          { error: 'Tài khoản này chưa bật xác thực 2 lớp (2FA).' },
          { status: 400 }
        );
      }

      const rawPassword =
        typeof body.currentPassword === 'string'
          ? body.currentPassword
          : typeof body.password === 'string'
          ? body.password
          : '';
      const rawCode = String(
        body.code ?? body.totpCode ?? body.token ?? ''
      ).trim();

      if (!rawPassword || !rawCode) {
        return NextResponse.json(
          {
            error:
              'Vui lòng nhập đầy đủ mật khẩu hiện tại và mã 2FA (hoặc Mã khôi phục) để xác nhận tắt bảo mật 2 lớp.',
          },
          { status: 400 }
        );
      }

      if (!(await verifyPasswordAsync(rawPassword, String(user.password_hash)))) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          { error: 'Mật khẩu xác nhận không chính xác.' },
          { status: 400 }
        );
      }

      if (user.totp_secret) {
        const plainSecret = decryptTotpSecret(String(user.totp_secret));
        const stepCheck = verifyTotpCodeWithStep(plainSecret, rawCode);
        const validTotp =
          stepCheck.valid &&
          stepCheck.matchedStep !== null &&
          consumeTotpStepAtomically(userId, stepCheck.matchedStep);
        const validRec = !validTotp
          ? verifyAndConsumeRecoveryCode(
              rawCode,
              String(user.recovery_codes_json || '[]')
            ).matched
          : false;
        if (!validTotp && !validRec) {
          recordLoginFailure(reauthKey);
          return NextResponse.json(
            { error: 'Mã xác thực 2FA không chính xác hoặc vừa được sử dụng.' },
            { status: 400 }
          );
        }
      }
      clearLoginFailures(reauthKey);

      const nextTokenVersion = Number(user.token_version ?? 1) + 1;
      db.prepare(
        `UPDATE users
         SET totp_enabled = 0,
             totp_secret = NULL,
             totp_pending_secret = NULL,
             totp_last_used_step = 0,
             recovery_codes_json = '[]',
             token_version = ?
         WHERE id = ?`
      ).run(nextTokenVersion, userId);

      const freshToken = await signSessionToken({
        userId,
        username,
        role: normalizeUserRole(user.role || 'ADMIN'),
        tokenVersion: nextTokenVersion,
      });

      recordAuditLog({
        session,
        action: 'AUTH_2FA_DISABLED',
        resourceType: 'USER',
        resourceId: String(userId),
        detail: 'Đã tắt xác thực 2 lớp (2FA TOTP)',
        req,
      });

      const res = NextResponse.json({
        ok: true,
        enabled: false,
        totpEnabled: false,
        recoveryCodesRemaining: 0,
        remainingRecoveryCodes: 0,
        message: 'Đã tắt xác thực 2 lớp (2FA).',
      });
      res.cookies.set(SESSION_COOKIE_NAME, freshToken, sessionCookieOptions(req));
      return res;
    }

    if (action === 'regenerate_recovery') {
      if (Number(user.totp_enabled) !== 1 || !user.totp_secret) {
        return NextResponse.json(
          { error: 'Vui lòng bật 2FA trước khi tạo lại mã khôi phục.' },
          { status: 400 }
        );
      }

      const rawPassword =
        typeof body.currentPassword === 'string'
          ? body.currentPassword
          : typeof body.password === 'string'
          ? body.password
          : '';
      const rawCode = String(
        body.code ?? body.totpCode ?? body.token ?? ''
      ).trim();

      if (!rawPassword || !rawCode) {
        return NextResponse.json(
          {
            error:
              'Vui lòng nhập đầy đủ mật khẩu hiện tại và mã TOTP 6 số để xác nhận tạo mới mã khôi phục.',
          },
          { status: 400 }
        );
      }

      if (!(await verifyPasswordAsync(rawPassword, String(user.password_hash)))) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          { error: 'Mật khẩu xác nhận không chính xác.' },
          { status: 400 }
        );
      }

      const plainSecret = decryptTotpSecret(String(user.totp_secret));
      const stepCheck = verifyTotpCodeWithStep(plainSecret, rawCode);
      if (
        !stepCheck.valid ||
        stepCheck.matchedStep === null ||
        !consumeTotpStepAtomically(userId, stepCheck.matchedStep)
      ) {
        recordLoginFailure(reauthKey);
        return NextResponse.json(
          { error: 'Mã TOTP 6 chữ số không chính xác hoặc vừa được sử dụng.' },
          { status: 400 }
        );
      }
      clearLoginFailures(reauthKey);

      const { plainCodes, hashedJson } = generateRecoveryCodes(8);
      db.prepare('UPDATE users SET recovery_codes_json = ? WHERE id = ?').run(
        hashedJson,
        userId
      );

      recordAuditLog({
        session,
        action: 'AUTH_2FA_RECOVERY_REGEN',
        resourceType: 'USER',
        resourceId: String(userId),
        detail: 'Đã khởi tạo lại bộ 8 mã khôi phục 2FA (vô hiệu hóa các mã cũ)',
        req,
      });

      return NextResponse.json({
        ok: true,
        recoveryCodes: plainCodes,
        recoveryCodesRemaining: plainCodes.length,
        remainingRecoveryCodes: plainCodes.length,
        message: 'Đã tạo mới 8 mã khôi phục khẩn cấp thành công!',
      });
    }

    return NextResponse.json(
      { error: `Hành động 2FA "${action}" không hợp lệ.` },
      { status: 400 }
    );
  } catch (err) {
    return safeErrorJson(err, 'Lỗi máy chủ khi xử lý 2FA.', 500);
  }
}

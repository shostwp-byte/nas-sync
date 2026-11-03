import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { extractRequestIp, recordAuditLog } from '@/lib/audit';
import {
  SESSION_COOKIE_NAME,
  hashPassword,
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
  consumeTotpStepAtomically,
  decryptTotpSecret,
  encryptTotpSecret,
  verifyAndConsumeRecoveryCode,
  verifyTotpCodeWithStep,
} from '@/lib/totp';

const DUMMY_TIMING_PASSWORD_HASH = hashPassword(
  'nas-sync-constant-time-login-equalizer'
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const totpCode = String(body.totpCode ?? body.code ?? '').trim();

    if (!username || !password) {
      return NextResponse.json(
        { error: 'Vui lòng nhập đầy đủ Tên đăng nhập và Mật khẩu.' },
        { status: 400 }
      );
    }

    if (username.length > 64 || password.length > 256 || totpCode.length > 64) {
      return NextResponse.json(
        { error: 'Thông tin đăng nhập vượt quá độ dài cho phép.' },
        { status: 400 }
      );
    }

    const clientIp = extractRequestIp(req);
    const throttleKey = `${clientIp}|${username.toLowerCase()}`;
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

    // A13 Fix: Chạy scrypt bất đồng bộ trên libuv threadpool để không khóa Event Loop
    const passwordHashToVerify = user
      ? String(user.password_hash)
      : DUMMY_TIMING_PASSWORD_HASH;
    const passwordMatches = await verifyPasswordAsync(
      password,
      passwordHashToVerify
    );

    if (!user || !passwordMatches) {
      recordLoginFailure(throttleKey);
      recordAuditLog({
        userId: user ? Number(user.id) : null,
        username,
        action: 'AUTH_LOGIN_FAILED',
        resourceType: 'AUTH',
        detail: 'Đăng nhập thất bại: Sai tên đăng nhập hoặc mật khẩu',
        ipAddress: clientIp,
      });
      return NextResponse.json(
        { error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' },
        { status: 401 }
      );
    }

    const userId = Number(user.id);
    const dbUsername = String(user.username);
    const role = normalizeUserRole(user.role || 'ADMIN');
    const totpEnabled =
      Number(user.totp_enabled) === 1 && Boolean(user.totp_secret);

    let loginDetail = `Đăng nhập thành công (${role})`;

    if (totpEnabled) {
      if (!totpCode) {
        return NextResponse.json({
          ok: false,
          requiresTwoFactor: true,
          message:
            'Vui lòng nhập mã xác thực 2 lớp (6 số TOTP hoặc Mã khôi phục).',
        });
      }

      let isSecondFactorValid = false;
      try {
        const rawStoredSecret = String(user.totp_secret);
        const plainSecret = decryptTotpSecret(rawStoredSecret);
        const stepCheck = verifyTotpCodeWithStep(plainSecret, totpCode);
        if (
          stepCheck.valid &&
          stepCheck.matchedStep !== null &&
          consumeTotpStepAtomically(userId, stepCheck.matchedStep)
        ) {
          isSecondFactorValid = true;
          if (rawStoredSecret.startsWith('v1:')) {
            db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(
              encryptTotpSecret(plainSecret),
              userId
            );
          }
        }
      } catch {
        isSecondFactorValid = false;
      }

      if (!isSecondFactorValid) {
        const recoveryCheck = verifyAndConsumeRecoveryCode(
          totpCode,
          String(user.recovery_codes_json || '[]')
        );
        if (recoveryCheck.matched) {
          isSecondFactorValid = true;
          db.prepare(
            'UPDATE users SET recovery_codes_json = ? WHERE id = ?'
          ).run(recoveryCheck.remainingJson, userId);
          loginDetail = `Đăng nhập bằng Mã khôi phục 2FA (còn lại ${recoveryCheck.remainingCount} mã)`;
        }
      } else {
        loginDetail = `Đăng nhập thành công qua 2FA TOTP (${role})`;
      }

      if (!isSecondFactorValid) {
        recordLoginFailure(throttleKey);
        recordAuditLog({
          userId,
          username: dbUsername,
          action: 'AUTH_2FA_FAILED',
          resourceType: 'AUTH',
          resourceId: String(userId),
          detail:
            'Xác thực 2 lớp (2FA) thất bại: Mã TOTP không hợp lệ, đã hết hạn hoặc bị phát lại (replay)',
          ipAddress: clientIp,
        });
        return NextResponse.json(
          {
            error:
              'Mã xác thực 2 lớp (2FA) không chính xác, đã hết hạn hoặc vừa được sử dụng.',
          },
          { status: 401 }
        );
      }
    }

    clearLoginFailures(throttleKey);

    db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(
      userId
    );

    const token = await signSessionToken({
      userId,
      username: dbUsername,
      role,
      tokenVersion: Number(user.token_version ?? 1),
    });

    recordAuditLog({
      userId,
      username: dbUsername,
      action: 'AUTH_LOGIN',
      resourceType: 'AUTH',
      resourceId: String(userId),
      detail: loginDetail,
      ipAddress: clientIp,
    });

    const res = NextResponse.json({
      ok: true,
      user: {
        id: userId,
        username: dbUsername,
        role,
        totpEnabled,
      },
    });

    res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(req));

    return res;
  } catch (err) {
    return safeErrorJson(err, 'Lỗi máy chủ khi đăng nhập.', 500);
  }
}

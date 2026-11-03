import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson, sanitizeErrorMessage } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getSetting, setSettings } from '@/lib/db';
import { ensureJwtSecret } from '@/lib/jwt-secret';

const SECRET_MASK = '••••••••';
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000; // 15 phút

function getOauthStateSigningKey(): string {
  ensureJwtSecret();
  return process.env.JWT_SECRET || 'nas-sync-oauth-fallback-key';
}

function resolveRequestOrigin(req: NextRequest): string {
  const fwdProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const fwdHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = fwdHost || req.headers.get('host')?.split(',')[0]?.trim();
  if (host) {
    const proto =
      fwdProto === 'https' || fwdProto === 'http'
        ? fwdProto
        : req.nextUrl.protocol.replace(/:$/, '') || 'http';
    return `${proto}://${host}`;
  }
  return req.nextUrl.origin;
}

function createSignedOauthState(userId: number): string {
  const payload = JSON.stringify({
    uid: userId,
    ts: Date.now(),
    nonce: crypto.randomBytes(12).toString('hex'),
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', getOauthStateSigningKey())
    .update(payloadB64, 'utf8')
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

function verifySignedOauthState(
  rawState: string,
  expectedUserId: number
): { ok: boolean; error?: string } {
  const dotIdx = rawState.indexOf('.');
  if (dotIdx <= 0) {
    return { ok: false, error: 'Tham số state OAuth2 không hợp lệ.' };
  }
  const payloadB64 = rawState.slice(0, dotIdx);
  const sigB64 = rawState.slice(dotIdx + 1);

  const expectedSig = crypto
    .createHmac('sha256', getOauthStateSigningKey())
    .update(payloadB64, 'utf8')
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return {
      ok: false,
      error: 'Chữ ký bảo mật OAuth2 state không khớp (nghi vấn CSRF).',
    };
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as { uid?: number; ts?: number };
    if (decoded.uid !== expectedUserId) {
      return {
        ok: false,
        error: 'Phiên quản trị viên hiện tại không khớp với người khởi tạo OAuth2.',
      };
    }
    const age = Date.now() - Number(decoded.ts || 0);
    if (!Number.isFinite(age) || age < -60_000 || age > OAUTH_STATE_TTL_MS) {
      return {
        ok: false,
        error: 'Phiên ủy quyền Google OAuth2 đã quá hạn 15 phút. Vui lòng bấm kết nối lại.',
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Không thể giải mã trạng thái OAuth2 state.' };
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json().catch(() => ({}));
    const rawClientId = String(body.clientId ?? '').trim();
    const rawClientSecret = String(body.clientSecret ?? '').trim();

    const updates: Record<string, string> = {};
    if (rawClientId && rawClientId !== SECRET_MASK) {
      updates.offsite_gdrive_client_id = rawClientId;
    }
    if (rawClientSecret && rawClientSecret !== SECRET_MASK) {
      updates.offsite_gdrive_client_secret = rawClientSecret;
    }
    if (Object.keys(updates).length > 0) {
      setSettings(updates);
    }

    const clientId =
      updates.offsite_gdrive_client_id ||
      getSetting('offsite_gdrive_client_id').trim();
    const clientSecret =
      updates.offsite_gdrive_client_secret ||
      getSetting('offsite_gdrive_client_secret').trim();

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        {
          error:
            'Vui lòng nhập đầy đủ Google OAuth2 Client ID và Client Secret trước khi ủy quyền.',
        },
        { status: 400 }
      );
    }

    const origin = resolveRequestOrigin(req);
    const redirectUri = `${origin}/api/offsite/gdrive-oauth`;
    const state = createSignedOauthState(guard.session.userId);

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('state', state);

    return NextResponse.json({
      ok: true,
      authUrl: authUrl.toString(),
      redirectUri,
    });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể khởi tạo liên kết ủy quyền Google Drive OAuth2.'
    );
  }
}

export async function GET(req: NextRequest) {
  const origin = resolveRequestOrigin(req);
  const redirectWithError = (msg: string) =>
    NextResponse.redirect(
      new URL(`/settings?gdrive_error=${encodeURIComponent(msg)}`, origin)
    );

  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) {
      return redirectWithError(
        'Vui lòng đăng nhập bằng tài khoản ADMIN trước khi kết nối Google Drive.'
      );
    }

    const sp = req.nextUrl.searchParams;
    const oauthErr = sp.get('error');
    if (oauthErr) {
      return redirectWithError(`Google từ chối ủy quyền: ${oauthErr}`);
    }

    const code = (sp.get('code') || '').trim();
    const state = (sp.get('state') || '').trim();
    if (!code || !state) {
      return redirectWithError('Thiếu mã xác thực (code) hoặc tham số state từ Google.');
    }

    const stateCheck = verifySignedOauthState(state, guard.session.userId);
    if (!stateCheck.ok) {
      return redirectWithError(stateCheck.error || 'State OAuth2 không hợp lệ.');
    }

    const clientId = getSetting('offsite_gdrive_client_id').trim();
    const clientSecret = getSetting('offsite_gdrive_client_secret').trim();
    if (!clientId || !clientSecret) {
      return redirectWithError(
        'Thiếu OAuth2 Client ID hoặc Client Secret trong cấu hình hệ thống.'
      );
    }

    const redirectUri = `${origin}/api/offsite/gdrive-oauth`;
    const tokenBody = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });

    const tokenData = (await tokenResp.json().catch(() => ({}))) as {
      refresh_token?: string;
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (!tokenResp.ok) {
      return redirectWithError(
        `Trao đổi mã OAuth2 thất bại: ${
          tokenData.error_description || tokenData.error || `HTTP ${tokenResp.status}`
        }`
      );
    }

    if (!tokenData.refresh_token) {
      return redirectWithError(
        'Google không trả về refresh_token. Vui lòng thử bấm kết nối lại và chấp nhận quyền truy cập Drive.'
      );
    }

    setSettings({
      offsite_gdrive_refresh_token: tokenData.refresh_token,
      offsite_gdrive_auth_mode: 'OAUTH2',
    });

    recordAuditLog({
      session: guard.session,
      action: 'GDRIVE_OAUTH_CONNECTED',
      resourceType: 'SETTINGS',
      detail:
        'Ủy quyền thành công Google Drive OAuth2 cho sao lưu Offsite 3-2-1',
      req,
    });

    return NextResponse.redirect(new URL('/settings?gdrive=connected', origin));
  } catch (err) {
    return redirectWithError(
      sanitizeErrorMessage(err, 'Lỗi xử lý callback Google Drive OAuth2.')
    );
  }
}

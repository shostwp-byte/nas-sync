import http from 'node:http';
import https from 'node:https';
import { getSetting } from '@/lib/db';
import { createSystemAlert } from '@/lib/notifications';

export interface BtrfsSnapshotResult {
  ok: boolean;
  simulated?: boolean;
  sharesProcessed: string[];
  retentionDays: number;
  message: string;
}

function validateDsmBaseUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('DSM_API_URL không hợp lệ (phải có dạng http:// hoặc https://).');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('DSM_API_URL chỉ chấp nhận giao thức http: hoặc https:.');
  }
  return parsed;
}

function postDsmForm<T>(
  baseUrl: string,
  cgiPath: string,
  params: URLSearchParams
): Promise<T> {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(`${baseUrl}${cgiPath}`);
    const body = params.toString();
    const isHttps = targetUrl.protocol === 'https:';
    const verifyTls = process.env.DSM_TLS_VERIFY === 'true';

    const requestOptions: https.RequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
      ...(isHttps ? { rejectUnauthorized: verifyTls } : {}),
    };

    const transport = isHttps ? https : http;
    const req = transport.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 1024 * 1024) {
          req.destroy(new Error('Phản hồi từ Synology DSM vượt quá kích thước cho phép.'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          const parsed = JSON.parse(raw) as T;
          resolve(parsed);
        } catch {
          reject(
            new Error(
              `Synology DSM trả về dữ liệu không hợp lệ (HTTP ${res.statusCode ?? 0}).`
            )
          );
        }
      });
    });

    req.setTimeout(15000, () => {
      req.destroy(
        new Error('Quá thời gian chờ kết nối Synology DSM API (15 giây).')
      );
    });

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

/**
 * Mục 9.1: Chống Ransomware bằng Btrfs Immutable Snapshot (WORM) trên Synology DSM
 * Gọi API của Synology DSM (SYNO.API.Auth -> SYNO.Core.Share.Snapshot) để tạo bản chụp
 * Btrfs khóa cứng chống xóa/ghi đè (Immutable WORM) trong N ngày (Mặc định 7 ngày).
 */
export async function triggerSynologyBtrfsImmutableSnapshot(
  retentionDays = 7
): Promise<BtrfsSnapshotResult> {
  const safeRetentionDays = Math.max(
    1,
    Math.min(3650, Math.floor(Number(retentionDays) || 7))
  );
  const dsmUrl = getSetting('dsm_api_url').trim().replace(/\/+$/, '');
  const username = getSetting('dsm_username');
  const password = getSetting('dsm_password');
  const sharesRaw = getSetting('dsm_backup_shares', 'VPS_Backups');
  const shares = sharesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!dsmUrl || !username || !password) {
    const msg = `Đã ghi nhận yêu cầu chụp Btrfs Immutable Snapshot (WORM ${safeRetentionDays} ngày) cho Shared Folder [${shares.join(
      ', '
    )}] (Chế độ mô phỏng — Chưa cấu hình DSM_API_URL / tài khoản DSM trong mục Cài đặt).`;

    await createSystemAlert({
      severity: 'INFO',
      category: 'BTRFS',
      title: `Btrfs Immutable Snapshot (Mô phỏng WORM ${safeRetentionDays} ngày)`,
      message: msg,
      notifyExternal: false,
    });

    return {
      ok: true,
      simulated: true,
      sharesProcessed: shares,
      retentionDays: safeRetentionDays,
      message: msg,
    };
  }

  try {
    validateDsmBaseUrl(dsmUrl);

    // Bước 1: Xác thực Synology DSM WebAPI (SYNO.API.Auth) qua POST body (không lộ mật khẩu trên URL)
    const authParams = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: username,
      passwd: password,
      session: 'NasSyncWORM',
      format: 'sid',
    });

    const authJson = await postDsmForm<{
      success?: boolean;
      data?: { sid?: string };
      error?: { code?: number };
    }>(dsmUrl, '/webapi/auth.cgi', authParams);

    if (!authJson.success || !authJson.data?.sid) {
      throw new Error(
        `Đăng nhập Synology DSM API thất bại (Mã lỗi: ${
          authJson.error?.code ?? 'unknown'
        })`
      );
    }

    const sid = authJson.data.sid;
    const processed: string[] = [];

    try {
      // Bước 2: Gọi tạo Btrfs Immutable Snapshot (WORM) cho từng Shared Folder chứa Backup qua POST body
      for (const share of shares) {
        const snapParams = new URLSearchParams({
          api: 'SYNO.Core.Share.Snapshot',
          version: '2',
          method: 'create',
          name: share,
          desc: `NAS-Sync Auto Immutable WORM (${safeRetentionDays}d)`,
          is_locked: 'true',
          immutable: 'true',
          immutable_days: String(safeRetentionDays),
          _sid: sid,
        });

        const snapJson = await postDsmForm<{
          success?: boolean;
          error?: { code?: number };
        }>(dsmUrl, '/webapi/entry.cgi', snapParams);

        if (!snapJson.success) {
          throw new Error(
            `Tạo Immutable Snapshot trên Share "${share}" thất bại (DSM Error ${
              snapJson.error?.code ?? 'unknown'
            })`
          );
        }
        processed.push(share);
      }
    } finally {
      // Bước 3: Đăng xuất phiên DSM API qua POST body
      const logoutParams = new URLSearchParams({
        api: 'SYNO.API.Auth',
        version: '6',
        method: 'logout',
        session: 'NasSyncWORM',
        _sid: sid,
      });
      await postDsmForm(dsmUrl, '/webapi/auth.cgi', logoutParams).catch(() => {});
    }

    const successMsg = `Đã khóa Btrfs Immutable Snapshot (WORM ${safeRetentionDays} ngày chống Ransomware) thành công cho Shared Folder: ${processed.join(
      ', '
    )}.`;

    await createSystemAlert({
      severity: 'INFO',
      category: 'BTRFS',
      title: `Đã tạo Btrfs Immutable Snapshot (${safeRetentionDays} ngày WORM)`,
      message: successMsg,
      notifyExternal: false,
    });

    return {
      ok: true,
      sharesProcessed: processed,
      retentionDays: safeRetentionDays,
      message: successMsg,
    };
  } catch (err) {
    const errMsg = `Lỗi gọi Synology DSM Btrfs Snapshot API: ${(err as Error).message}`;
    await createSystemAlert({
      severity: 'WARNING',
      category: 'BTRFS',
      title: 'Không thể tạo Btrfs Immutable Snapshot trên DSM',
      message: errMsg,
    });
    return {
      ok: false,
      sharesProcessed: [],
      retentionDays: safeRetentionDays,
      message: errMsg,
    };
  }
}


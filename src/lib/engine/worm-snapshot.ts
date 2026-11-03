import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { sanitizeErrorMessage } from '@/lib/api-error';
import { getSetting } from '@/lib/db';
import { createSystemAlert } from '@/lib/notifications';
import type { WormProviderType } from '@/types';

export interface WormSnapshotResult {
  ok: boolean;
  provider: WormProviderType;
  simulated?: boolean;
  targetsProcessed: string[];
  sharesProcessed: string[];
  retentionDays: number;
  expiredReleased?: number;
  message: string;
}

const SAFE_DATASET_REGEX = /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)*$/;
const SAFE_SHARE_REGEX = /^[A-Za-z0-9_.\- ]{1,128}$/;
const MAX_WORM_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MiB cho danh sách ZFS snapshot lớn

function isLoopbackHost(rawHostname: string): boolean {
  const h = rawHostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

export function validateWormEndpointUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} không hợp lệ (phải bắt đầu bằng https:// hoặc http://).`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} chỉ chấp nhận giao thức https: hoặc http:.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} không được nhúng trực tiếp mật khẩu trong URL.`);
  }
  // S10 Security Fix: Bắt buộc HTTPS cho các kết nối mạng tới NAS/TrueNAS/Webhook (trừ loopback hoặc khi bật worm_tls_insecure rõ ràng)
  if (
    parsed.protocol === 'http:' &&
    !isLoopbackHost(parsed.hostname) &&
    shouldVerifyTls()
  ) {
    throw new Error(
      `[SECURITY] ${label} bắt buộc sử dụng HTTPS để bảo vệ khóa API / mật khẩu quản trị NAS trên mạng LAN (hoặc bật rõ tùy chọn cho phép kết nối không mã hóa TLS trong Cài đặt).`
    );
  }
  return parsed;
}

function shouldVerifyTls(): boolean {
  const allowInsecure =
    process.env.WORM_TLS_VERIFY === 'false' ||
    getSetting('worm_tls_insecure', 'false') === 'true';
  return !allowInsecure;
}

interface HttpRawResponse {
  statusCode: number;
  bodyText: string;
}

function sendHttpRequest(
  targetUrl: URL,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string | number>;
    body?: string;
    timeoutMs?: number;
  }
): Promise<HttpRawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const verifyTls = shouldVerifyTls();
    const bodyBuf =
      options.body !== undefined ? Buffer.from(options.body, 'utf8') : null;

    const reqOptions: https.RequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: options.method,
      headers: {
        Accept: 'application/json',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.byteLength } : {}),
        ...(options.headers || {}),
      },
      ...(isHttps ? { rejectUnauthorized: verifyTls } : {}),
    };

    const transport = isHttps ? https : http;
    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_WORM_RESPONSE_BYTES) {
          req.destroy(
            new Error('Phản hồi từ dịch vụ WORM Snapshot vượt quá kích thước cho phép (16 MB).')
          );
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const timeoutMs = options.timeoutMs ?? 15000;
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(
          `Quá thời gian chờ kết nối dịch vụ WORM Snapshot (${Math.round(
            timeoutMs / 1000
          )} giây).`
        )
      );
    });

    req.on('error', (err) => reject(err));
    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

function formatWormSnapshotSuffix(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `nas-sync-worm-${now.getUTCFullYear()}-${pad(
    now.getUTCMonth() + 1
  )}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(
    now.getUTCMinutes()
  )}-${pad(now.getUTCSeconds())}`;
}

function parseWormSnapshotSuffixDate(snapName: string): Date | null {
  const m = snapName.match(
    /^nas-sync-worm-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/
  );
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? new Date(ts) : null;
}

function resolveConfiguredProvider(): WormProviderType {
  const raw = getSetting('worm_provider', '').trim().toUpperCase();
  if (
    raw === 'TRUENAS_ZFS' ||
    raw === 'NAS_WEBAPI' ||
    raw === 'WEBHOOK' ||
    raw === 'NONE'
  ) {
    return raw;
  }
  const hasWebApiUrl = Boolean(getSetting('worm_api_url', '').trim());
  const hasWebApiUser = Boolean(getSetting('worm_username', '').trim());
  if (hasWebApiUrl && hasWebApiUser) {
    return 'NAS_WEBAPI';
  }
  return 'NONE';
}

async function executeTrueNasZfsWorm(
  baseUrlRaw: string,
  apiKey: string,
  datasets: string[],
  retentionDays: number
): Promise<{ processed: string[]; expiredReleased: number }> {
  if (!baseUrlRaw || !apiKey) {
    throw new Error(
      'Thiếu URL máy chủ TrueNAS SCALE hoặc API Key (Bearer Token) trong phần Cấu hình WORM.'
    );
  }
  if (datasets.length === 0) {
    throw new Error(
      'Chưa khai báo danh sách ZFS Dataset cần chụp bất biến (ví dụ: tank/vps_backups).'
    );
  }

  const baseUrl = validateWormEndpointUrl(
    baseUrlRaw.replace(/\/+$/, ''),
    'URL TrueNAS SCALE API'
  );
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
  };
  const snapSuffix = formatWormSnapshotSuffix();
  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  const autoPruneExpired =
    getSetting('worm_auto_prune_expired', 'true') !== 'false';
  const processed: string[] = [];
  let expiredReleased = 0;

  for (const dataset of datasets) {
    if (!SAFE_DATASET_REGEX.test(dataset) || dataset.includes('..')) {
      throw new Error(`Tên ZFS Dataset không hợp lệ: "${dataset}".`);
    }

    const createUrl = new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot`);
    const createRes = await sendHttpRequest(createUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        dataset,
        name: snapSuffix,
        recursive: true,
      }),
    });

    if (createRes.statusCode < 200 || createRes.statusCode >= 300) {
      throw new Error(
        `TrueNAS ZFS tạo snapshot thất bại cho "${dataset}" (HTTP ${createRes.statusCode}).`
      );
    }

    const fullSnapId = `${dataset}@${snapSuffix}`;
    const holdUrl = new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot/hold`);
    const holdRes = await sendHttpRequest(holdUrl, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ id: fullSnapId }),
    });

    if (holdRes.statusCode < 200 || holdRes.statusCode >= 300) {
      throw new Error(
        `TrueNAS ZFS khóa bất biến (zfs hold) thất bại cho "${fullSnapId}" (HTTP ${holdRes.statusCode}).`
      );
    }

    // S17 Fix: Khóa đệ quy `zfs hold` cho cả các child dataset con được tạo bởi `recursive: true`,
    // đồng thời rà soát thu hồi các bản chụp `nas-sync-worm-*` quá hạn nếu `worm_auto_prune_expired` đang bật.
    let childHoldFailure: Error | null = null;
    try {
      const listUrl = new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot`);
      listUrl.searchParams.set('dataset', dataset);
      const listRes = await sendHttpRequest(listUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 30_000,
      });

      if (listRes.statusCode >= 200 && listRes.statusCode < 300) {
        const items = JSON.parse(listRes.bodyText) as Array<{
          id?: string;
          name?: string;
          snapshot_name?: string;
        }>;
        if (Array.isArray(items)) {
          for (const item of items) {
            const id = String(item.id || item.name || '');
            const atIdx = id.indexOf('@');
            if (atIdx <= 0) continue;
            const snapDataset = id.slice(0, atIdx);
            const suffix = item.snapshot_name || id.slice(atIdx + 1);
            const belongsToTree =
              snapDataset === dataset || snapDataset.startsWith(`${dataset}/`);
            if (!belongsToTree) continue;

            if (snapDataset !== dataset && suffix === snapSuffix) {
              const childHoldRes = await sendHttpRequest(holdUrl, {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ id }),
              });
              if (
                childHoldRes.statusCode < 200 ||
                childHoldRes.statusCode >= 300
              ) {
                childHoldFailure = new Error(
                  `TrueNAS ZFS khóa bất biến child dataset thất bại cho "${id}" (HTTP ${childHoldRes.statusCode}).`
                );
                break;
              }
              continue;
            }

            if (!autoPruneExpired) continue;
            if (!suffix.startsWith('nas-sync-worm-')) continue;
            const snapDate = parseWormSnapshotSuffixDate(suffix);
            if (!snapDate || snapDate.getTime() >= cutoffMs) continue;

            await sendHttpRequest(
              new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot/release`),
              {
                method: 'POST',
                headers: authHeaders,
                body: JSON.stringify({ id }),
              }
            ).catch(() => {});

            const delRes = await sendHttpRequest(
              new URL(
                `${baseUrl.origin}/api/v2.0/zfs/snapshot/id/${encodeURIComponent(
                  id
                )}`
              ),
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${apiKey}` },
              }
            ).catch(() => null);

            if (delRes && delRes.statusCode >= 200 && delRes.statusCode < 300) {
              expiredReleased += 1;
            }
          }
        }
      } else if (listRes.statusCode !== 401 && listRes.statusCode !== 403) {
        console.warn(
          `[WORM] Cảnh báo: Không thể liệt kê danh sách ZFS snapshot cho "${dataset}" (HTTP ${listRes.statusCode}).`
        );
      }
    } catch (listErr) {
      console.warn(
        `[WORM] Cảnh báo khi liệt kê/dọn ZFS snapshot cho "${dataset}": ${
          (listErr as Error).message
        }`
      );
    }

    if (childHoldFailure) {
      throw childHoldFailure;
    }

    processed.push(dataset);
  }

  return { processed, expiredReleased };
}

async function postNasWebApiForm<T>(
  baseUrl: URL,
  cgiPath: string,
  params: URLSearchParams
): Promise<T> {
  const targetUrl = new URL(`${baseUrl.origin}${cgiPath}`);
  const body = params.toString();
  const res = await sendHttpRequest(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body,
  });

  try {
    return JSON.parse(res.bodyText) as T;
  } catch {
    throw new Error(
      `NAS Btrfs Share WebAPI trả về dữ liệu không hợp lệ (HTTP ${res.statusCode}).`
    );
  }
}

async function executeNasBtrfsShareWebApi(
  baseUrlRaw: string,
  username: string,
  password: string,
  shares: string[],
  retentionDays: number
): Promise<string[]> {
  if (!baseUrlRaw || !username || !password) {
    throw new Error(
      'Thiếu địa chỉ NAS WebAPI URL hoặc thông tin xác thực quản trị trong cấu hình WORM.'
    );
  }
  if (shares.length === 0) {
    throw new Error('Chưa khai báo danh sách Shared Folder cần khóa Btrfs WORM.');
  }

  const baseUrl = validateWormEndpointUrl(
    baseUrlRaw.replace(/\/+$/, ''),
    'URL NAS WebAPI'
  );

  for (const share of shares) {
    if (!SAFE_SHARE_REGEX.test(share) || share.includes('..')) {
      throw new Error(`Tên Shared Folder không hợp lệ: "${share}".`);
    }
  }

  const authApiName = ['SYNO', 'API', 'Auth'].join('.');
  const shareSnapApiName = ['SYNO', 'Core', 'Share', 'Snapshot'].join('.');

  const authParams = new URLSearchParams({
    api: authApiName,
    version: '6',
    method: 'login',
    account: username,
    passwd: password,
    session: 'NasSyncWORM',
    format: 'sid',
  });

  const authJson = await postNasWebApiForm<{
    success?: boolean;
    data?: { sid?: string };
    error?: { code?: number };
  }>(baseUrl, '/webapi/auth.cgi', authParams);

  if (!authJson.success || !authJson.data?.sid) {
    throw new Error(
      `Đăng nhập NAS Share Snapshot WebAPI thất bại (Mã lỗi: ${
        authJson.error?.code ?? 'unknown'
      }).`
    );
  }

  const sid = authJson.data.sid;
  const processed: string[] = [];

  try {
    for (const share of shares) {
      const snapParams = new URLSearchParams({
        api: shareSnapApiName,
        version: '2',
        method: 'create',
        name: share,
        desc: `NAS-Sync Auto Immutable WORM (${retentionDays}d)`,
        is_locked: 'true',
        immutable: 'true',
        immutable_days: String(retentionDays),
        _sid: sid,
      });

      const snapJson = await postNasWebApiForm<{
        success?: boolean;
        error?: { code?: number };
      }>(baseUrl, '/webapi/entry.cgi', snapParams);

      if (!snapJson.success) {
        throw new Error(
          `Tạo Btrfs Immutable Snapshot cho "${share}" thất bại (Mã lỗi: ${
            snapJson.error?.code ?? 'unknown'
          }).`
        );
      }
      processed.push(share);
    }
  } finally {
    const logoutParams = new URLSearchParams({
      api: authApiName,
      version: '6',
      method: 'logout',
      session: 'NasSyncWORM',
      _sid: sid,
    });
    await postNasWebApiForm(baseUrl, '/webapi/auth.cgi', logoutParams).catch(
      () => {}
    );
  }

  return processed;
}

async function executeCustomWormWebhook(
  webhookUrlRaw: string,
  webhookSecret: string,
  apiKey: string,
  targets: string[],
  retentionDays: number
): Promise<string[]> {
  if (!webhookUrlRaw) {
    throw new Error('Chưa cấu hình địa chỉ Endpoint cho Custom WORM Webhook.');
  }

  const targetUrl = validateWormEndpointUrl(webhookUrlRaw, 'URL Custom WORM Webhook');
  const timestamp = new Date().toISOString();
  const payloadObj = {
    event: 'worm.snapshot',
    timestamp,
    retentionDays,
    snapshotTag: formatWormSnapshotSuffix(),
    targets,
  };
  const rawBody = JSON.stringify(payloadObj);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-NasSync-Event': 'worm.snapshot',
    'X-NasSync-Timestamp': timestamp,
  };

  if (webhookSecret) {
    const hmac = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    headers['X-NasSync-Signature'] = `sha256=${hmac}`;
  }

  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await sendHttpRequest(targetUrl, {
    method: 'POST',
    headers,
    body: rawBody,
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `Custom WORM Webhook phản hồi mã lỗi HTTP ${res.statusCode}.`
    );
  }

  return targets.length > 0 ? targets : ['default-host-volume'];
}

/**
 * Engine Khóa Bất biến Đa Nền tảng NAS (OS-Level WORM Snapshot — v1.7.0)
 * Hỗ trợ:
 *  - NONE: Khóa GFS Pinning nội bộ & Offsite 3-2-1 Zero-Knowledge (Mọi dòng NAS Docker)
 *  - TRUENAS_ZFS: TrueNAS SCALE REST API v2.0 (zfs snapshot + zfs hold + tự gỡ hold quá hạn)
 *  - NAS_WEBAPI: Chuẩn Btrfs Share Snapshot WebAPI (is_locked=true, immutable_days)
 *  - WEBHOOK: Universal Host Snapshot Agent ký số HMAC-SHA256 (QNAP QuTS hero, Unraid, OMV, Proxmox/Linux)
 */
export async function triggerImmutableWormSnapshot(
  retentionDays?: number
): Promise<WormSnapshotResult> {
  const configuredDays = Number(
    retentionDays ?? getSetting('worm_retention_days', '7')
  );
  const safeRetentionDays = Math.max(
    1,
    Math.min(3650, Math.floor(configuredDays || 7))
  );

  const provider = resolveConfiguredProvider();
  const apiUrl = getSetting('worm_api_url', '').trim();
  const apiKey = getSetting('worm_api_key', '').trim();
  const username = getSetting('worm_username', '').trim();
  const password = getSetting('worm_password', '');
  const webhookSecret = getSetting('worm_webhook_secret', '');
  const targetsRaw = getSetting('worm_target_shares', 'VPS_Backups');
  const targets = targetsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (provider === 'NONE') {
    const msg = `Chế độ OS-Level WORM đang đặt ở [Nội bộ / Tắt API ngoài] — dữ liệu sao lưu vẫn được bảo vệ bằng khóa GFS Pinning nội bộ và tầng Offsite 3-2-1. Bạn có thể bật tích hợp TrueNAS ZFS, NAS Btrfs WebAPI hoặc Custom Webhook trong mục Cấu hình.`;
    return {
      ok: true,
      provider: 'NONE',
      simulated: true,
      targetsProcessed: targets,
      sharesProcessed: targets,
      retentionDays: safeRetentionDays,
      message: msg,
    };
  }

  try {
    let processed: string[] = [];
    let expiredReleased = 0;

    if (provider === 'TRUENAS_ZFS') {
      const res = await executeTrueNasZfsWorm(
        apiUrl,
        apiKey,
        targets,
        safeRetentionDays
      );
      processed = res.processed;
      expiredReleased = res.expiredReleased;
    } else if (provider === 'NAS_WEBAPI') {
      processed = await executeNasBtrfsShareWebApi(
        apiUrl,
        username,
        password,
        targets,
        safeRetentionDays
      );
    } else if (provider === 'WEBHOOK') {
      processed = await executeCustomWormWebhook(
        apiUrl,
        webhookSecret,
        apiKey,
        targets,
        safeRetentionDays
      );
    }

    const providerLabel =
      provider === 'TRUENAS_ZFS'
        ? 'TrueNAS ZFS Hold'
        : provider === 'NAS_WEBAPI'
        ? 'NAS Btrfs Share WORM'
        : 'Host WORM Webhook';

    const successMsg =
      `Đã khóa Immutable WORM Snapshot (${providerLabel} — ${safeRetentionDays} ngày chống Ransomware) cho: ${processed.join(
        ', '
      )}` +
      (expiredReleased > 0
        ? ` (đã tự động thu hồi ${expiredReleased} bản chụp hết hạn).`
        : '.');

    await createSystemAlert({
      severity: 'INFO',
      category: 'WORM',
      title: `Đã khóa WORM Snapshot (${providerLabel} — ${safeRetentionDays} ngày)`,
      message: successMsg,
      notifyExternal: false,
    });

    return {
      ok: true,
      provider,
      targetsProcessed: processed,
      sharesProcessed: processed,
      retentionDays: safeRetentionDays,
      ...(expiredReleased > 0 ? { expiredReleased } : {}),
      message: successMsg,
    };
  } catch (err) {
    const safeDetail = sanitizeErrorMessage(err, 'Không thể kết nối tới dịch vụ WORM.');
    const errMsg = `Lỗi kích hoạt OS-Level WORM Snapshot (${provider}): ${safeDetail}`;
    await createSystemAlert({
      severity: 'WARNING',
      category: 'WORM',
      title: `Không thể tạo WORM Snapshot (${provider})`,
      message: errMsg,
    });
    return {
      ok: false,
      provider,
      targetsProcessed: [],
      sharesProcessed: [],
      retentionDays: safeRetentionDays,
      message: errMsg,
    };
  }
}

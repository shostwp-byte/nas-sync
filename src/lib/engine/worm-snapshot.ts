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

function readPositiveEnvMs(envKey: string, fallbackMs: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw >= 50 ? Math.floor(raw) : fallbackMs;
}

function getWormConnectTimeoutMs(): number {
  return readPositiveEnvMs('WORM_CONNECT_TIMEOUT_MS', 12_000);
}

function getWormAuthTimeoutMs(): number {
  return readPositiveEnvMs('WORM_AUTH_TIMEOUT_MS', 45_000);
}

function getWormSnapshotTimeoutMs(): number {
  return readPositiveEnvMs('WORM_REQUEST_TIMEOUT_MS', 120_000);
}

const DEFAULT_WORM_LOGOUT_TIMEOUT_MS = 10_000;

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

export interface HttpRawResponse {
  statusCode: number;
  bodyText: string;
}

export class WormTimeoutError extends Error {
  readonly phase: 'CONNECT' | 'EXECUTION';

  constructor(phase: 'CONNECT' | 'EXECUTION', message: string) {
    super(message);
    this.name = 'WormTimeoutError';
    this.phase = phase;
  }
}

function formatHostPort(targetUrl: URL): string {
  const defaultPort = targetUrl.protocol === 'https:' ? '443' : '80';
  const port = targetUrl.port || defaultPort;
  return `${targetUrl.hostname}:${port}`;
}

function mapWormNetworkError(err: unknown, targetUrl: URL): Error {
  if (err instanceof WormTimeoutError) {
    return err;
  }
  const e = err instanceof Error ? err : new Error(String(err));
  const code = String((e as NodeJS.ErrnoException).code || '');
  const msg = e.message || '';
  const hostPort = formatHostPort(targetUrl);

  if (
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    /self[- ]signed certificate|unable to verify the first certificate|Hostname\/IP does not match certificate/i.test(
      msg
    )
  ) {
    return new Error(
      `Chứng chỉ HTTPS tại ${hostPort} là chứng chỉ tự ký hoặc không khớp địa chỉ IP — vui lòng bật tùy chọn "Cho phép chứng chỉ HTTPS tự ký (Self-Signed) trên mạng nội bộ LAN" trong mục Cài đặt WORM.`
    );
  }

  if (
    code === 'EPROTO' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
    /wrong version number|unknown protocol/i.test(msg)
  ) {
    return new Error(
      `Lỗi giao thức TLS tại ${hostPort} — hãy kiểm tra xem URL có đang điền nhầm cổng HTTP thường thay vì cổng HTTPS quản trị của NAS hay không.`
    );
  }

  if (code === 'ECONNREFUSED') {
    return new Error(
      `Thiết bị NAS tại ${hostPort} từ chối kết nối (ECONNREFUSED — kiểm tra lại cổng HTTPS quản trị trong URL).`
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new Error(
      `Không thể phân giải tên miền "${targetUrl.hostname}" từ bên trong container — hãy ưu tiên điền địa chỉ IP LAN trực tiếp của NAS (ví dụ https://192.168.1.254:5001).`
    );
  }

  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new Error(
      `Không thể định tuyến mạng tới thiết bị NAS tại ${hostPort} (${code} — kiểm tra lại địa chỉ IP LAN hoặc cấu hình mạng Docker).`
    );
  }

  return e;
}

export function sendWormHttpRequest(
  targetUrl: URL,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string | number>;
    body?: string;
    connectTimeoutMs?: number;
    timeoutMs?: number;
  }
): Promise<HttpRawResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const verifyTls = shouldVerifyTls();
    const hostPort = formatHostPort(targetUrl);
    const connectTimeoutMs =
      options.connectTimeoutMs ?? getWormConnectTimeoutMs();
    const timeoutMs = options.timeoutMs ?? getWormAuthTimeoutMs();
    const bodyBuf =
      options.body !== undefined ? Buffer.from(options.body, 'utf8') : null;

    const reqOptions: https.RequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: options.method,
      agent: false,
      headers: {
        Accept: 'application/json',
        Connection: 'close',
        ...(bodyBuf ? { 'Content-Length': bodyBuf.byteLength } : {}),
        ...(options.headers || {}),
      },
      ...(isHttps ? { rejectUnauthorized: verifyTls } : {}),
    };

    let settled = false;
    let handshakeDone = false;
    let activeSocket: import('node:net').Socket | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let execTimer: ReturnType<typeof setTimeout> | null = null;

    const clearAllTimers = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (execTimer) {
        clearTimeout(execTimer);
        execTimer = null;
      }
    };

    const transport = isHttps ? https : http;
    const req = transport.request(reqOptions, (res) => {
      markConnected();
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_WORM_RESPONSE_BYTES) {
          clearAllTimers();
          req.destroy(
            new Error(
              'Phản hồi từ dịch vụ WORM Snapshot vượt quá kích thước cho phép (16 MB).'
            )
          );
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        resolve({
          statusCode: res.statusCode ?? 0,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        });
      });

      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        reject(mapWormNetworkError(err, targetUrl));
      });
    });

    const markConnected = () => {
      if (handshakeDone || settled) return;
      handshakeDone = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      execTimer = setTimeout(() => {
        if (settled) return;
        const execSec = Math.max(1, Math.round(timeoutMs / 1000));
        const err = new WormTimeoutError(
          'EXECUTION',
          `Thiết bị NAS tại ${hostPort} đã nhận kết nối nhưng xử lý tác vụ WORM quá thời gian chờ (${execSec} giây — ổ cứng đang thức dậy từ chế độ ngủ đông hoặc phân vùng đang đồng bộ I/O lớn).`
        );
        req.destroy(err);
        activeSocket?.destroy();
      }, timeoutMs);
    };

    connectTimer = setTimeout(() => {
      if (handshakeDone || settled) return;
      const connectSec = Math.max(1, Math.round(connectTimeoutMs / 1000));
      const err = new WormTimeoutError(
        'CONNECT',
        `Không thể mở kết nối mạng/TLS tới dịch vụ WORM tại ${hostPort} sau ${connectSec} giây (kiểm tra địa chỉ URL, cổng HTTPS hoặc Tường lửa NAS cho dải Docker).`
      );
      req.destroy(err);
      activeSocket?.destroy();
    }, connectTimeoutMs);

    req.on('socket', (sock) => {
      activeSocket = sock;
      if (isHttps) {
        sock.once('secureConnect', markConnected);
      } else if (!sock.connecting) {
        markConnected();
      } else {
        sock.once('connect', markConnected);
      }
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearAllTimers();
      reject(mapWormNetworkError(err, targetUrl));
    });

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

    const snapshotTimeoutMs = getWormSnapshotTimeoutMs();
    const createUrl = new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot`);
    const createRes = await sendWormHttpRequest(createUrl, {
      method: 'POST',
      headers: authHeaders,
      timeoutMs: snapshotTimeoutMs,
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
    const holdRes = await sendWormHttpRequest(holdUrl, {
      method: 'POST',
      headers: authHeaders,
      timeoutMs: snapshotTimeoutMs,
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
      const listRes = await sendWormHttpRequest(listUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: getWormAuthTimeoutMs(),
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
              const childHoldRes = await sendWormHttpRequest(holdUrl, {
                method: 'POST',
                headers: authHeaders,
                timeoutMs: snapshotTimeoutMs,
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

            await sendWormHttpRequest(
              new URL(`${baseUrl.origin}/api/v2.0/zfs/snapshot/release`),
              {
                method: 'POST',
                headers: authHeaders,
                timeoutMs: getWormAuthTimeoutMs(),
                body: JSON.stringify({ id }),
              }
            ).catch(() => {});

            const delRes = await sendWormHttpRequest(
              new URL(
                `${baseUrl.origin}/api/v2.0/zfs/snapshot/id/${encodeURIComponent(
                  id
                )}`
              ),
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${apiKey}` },
                timeoutMs: getWormAuthTimeoutMs(),
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

function describeNasWebApiAuthError(code?: number): string {
  switch (code) {
    case 400:
      return 'Sai tên tài khoản hoặc mật khẩu quản trị NAS';
    case 401:
      return 'Tài khoản quản trị NAS đang bị vô hiệu hóa';
    case 402:
      return 'Tài khoản không đủ quyền quản trị (cần thuộc nhóm administrators)';
    case 403:
      return 'Tài khoản quản trị đang bật xác thực 2 lớp (2FA/OTP) — vui lòng tạo tài khoản quản trị nội bộ riêng không bật OTP tương tác cho lịch tự động';
    case 407:
      return 'IP của container Docker đang bị Auto Block trên NAS chặn tạm thời — hãy thêm dải 172.16.0.0/12 vào Allow List trong Control Panel -> Security -> Protection';
    default:
      return `Mã lỗi: ${code ?? 'unknown'}`;
  }
}

function describeNasWebApiSnapshotError(code?: number): string {
  switch (code) {
    case 102:
    case 103:
      return `Mã lỗi ${code} — Thiết bị NAS chưa cài đặt hoặc chưa bật dịch vụ Snapshot Replication`;
    case 402:
      return 'Mã lỗi 402 — Tài khoản không đủ quyền chụp Snapshot hoặc Shared Folder chưa nằm trên phân vùng Btrfs';
    case 101:
    case 3301:
    case 3302:
      return `Mã lỗi ${code} — Không tìm thấy Shared Folder hoặc phân vùng chưa hỗ trợ khóa Immutable WORM`;
    default:
      return `Mã lỗi: ${code ?? 'unknown'}`;
  }
}

async function postNasWebApiForm<T>(
  baseUrl: URL,
  cgiPath: string,
  params: URLSearchParams,
  timeoutMs: number
): Promise<T> {
  const targetUrl = new URL(`${baseUrl.origin}${cgiPath}`);
  const body = params.toString();
  const res = await sendWormHttpRequest(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body,
    timeoutMs,
  });

  try {
    return JSON.parse(res.bodyText) as T;
  } catch {
    throw new Error(
      `NAS Btrfs Share WebAPI trả về dữ liệu không hợp lệ (HTTP ${res.statusCode}).`
    );
  }
}

async function loginNasWebApiWithSpinupRetry(
  baseUrl: URL,
  authApiName: string,
  username: string,
  password: string
): Promise<{
  authVersion: string;
  authJson: {
    success?: boolean;
    data?: { sid?: string };
    error?: { code?: number };
  };
}> {
  const authTimeoutMs = getWormAuthTimeoutMs();
  const buildAuthParams = (version: string) =>
    new URLSearchParams({
      api: authApiName,
      version,
      method: 'login',
      account: username,
      passwd: password,
      session: 'NasSyncWORM',
      format: 'sid',
    });

  let authVersion = '6';
  let authJson: {
    success?: boolean;
    data?: { sid?: string };
    error?: { code?: number };
  };

  try {
    authJson = await postNasWebApiForm(
      baseUrl,
      '/webapi/auth.cgi',
      buildAuthParams(authVersion),
      authTimeoutMs
    );
  } catch (err) {
    // Nếu TCP/TLS đã kết nối tới nginx nhưng CGI chờ ổ cứng RAID thức dậy từ chế độ ngủ đông (Hibernation) quá hạn lần 1,
    // tự động thử lại ngay 1 lần nữa khi dàn đĩa vừa quay đủ tốc độ.
    if (err instanceof WormTimeoutError && err.phase === 'EXECUTION') {
      console.warn(
        `[WORM] Bước xác thực NAS WebAPI quá hạn lần 1 khi đánh thức ổ cứng, đang tự động thử lại...`
      );
      authJson = await postNasWebApiForm(
        baseUrl,
        '/webapi/auth.cgi',
        buildAuthParams(authVersion),
        authTimeoutMs
      );
    } else {
      throw err;
    }
  }

  // Tương thích lùi cho các bản hệ điều hành NAS chỉ hỗ trợ Auth WebAPI v3 (trả mã lỗi 104 cho v6)
  if (!authJson.success && authJson.error?.code === 104) {
    authVersion = '3';
    authJson = await postNasWebApiForm(
      baseUrl,
      '/webapi/auth.cgi',
      buildAuthParams(authVersion),
      authTimeoutMs
    );
  }

  return { authVersion, authJson };
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

  const { authVersion, authJson } = await loginNasWebApiWithSpinupRetry(
    baseUrl,
    authApiName,
    username,
    password
  );

  if (!authJson.success || !authJson.data?.sid) {
    throw new Error(
      `Đăng nhập NAS Share Snapshot WebAPI thất bại (${describeNasWebApiAuthError(
        authJson.error?.code
      )}).`
    );
  }

  const sid = authJson.data.sid;
  const snapshotTimeoutMs = getWormSnapshotTimeoutMs();
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
      }>(baseUrl, '/webapi/entry.cgi', snapParams, snapshotTimeoutMs);

      if (!snapJson.success) {
        throw new Error(
          `Tạo Btrfs Immutable Snapshot cho "${share}" thất bại (${describeNasWebApiSnapshotError(
            snapJson.error?.code
          )}).`
        );
      }
      processed.push(share);
    }
  } finally {
    const logoutParams = new URLSearchParams({
      api: authApiName,
      version: authVersion,
      method: 'logout',
      session: 'NasSyncWORM',
      _sid: sid,
    });
    await postNasWebApiForm(
      baseUrl,
      '/webapi/auth.cgi',
      logoutParams,
      DEFAULT_WORM_LOGOUT_TIMEOUT_MS
    ).catch(() => {});
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

  const res = await sendWormHttpRequest(targetUrl, {
    method: 'POST',
    headers,
    body: rawBody,
    timeoutMs: getWormSnapshotTimeoutMs(),
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

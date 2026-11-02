import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAllSettings, getDb } from '@/lib/db';
import { createSystemAlert } from '@/lib/notifications';
import type { OffsiteProviderType, OffsiteSyncJob } from '@/types';
import { resolveSafeSnapshotRoot } from './explorer';
import { createOffsiteEncryptStream } from './offsite-crypto';
import { assertSafe, isSafeServerLabel, isSafeSnapshotName } from './safe-names';

const SECRET_MASK = '••••••••';
const MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB (>= 5 MiB S3 min AND 32 * 256 KiB Google Drive multiple)

export interface S3OffsiteConfig {
  preset: 'R2' | 'B2' | 'AWS' | 'CUSTOM';
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface GoogleDriveOffsiteConfig {
  authMode: 'OAUTH2' | 'SERVICE_ACCOUNT';
  folderId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  serviceAccountJson: string;
}

export interface AwsSigV4RequestInput {
  method: string;
  url: string | URL;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
  headers?: Record<string, string>;
  payloadHash?: string;
  body?: Buffer | Uint8Array | string;
  now?: Date;
}

export interface AwsSigV4SignedResult {
  headers: Record<string, string>;
  authorization: string;
  amzDate: string;
  dateStamp: string;
  payloadHash: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

export function awsUriEncode(input: string, encodeSlash = true): string {
  const bytes = Buffer.from(input, 'utf8');
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isUnreserved =
      (b >= 0x41 && b <= 0x5a) || // A-Z
      (b >= 0x61 && b <= 0x7a) || // a-z
      (b >= 0x30 && b <= 0x39) || // 0-9
      b === 0x2d || // -
      b === 0x5f || // _
      b === 0x2e || // .
      b === 0x7e; // ~
    if (isUnreserved) {
      out += String.fromCharCode(b);
    } else if (b === 0x2f && !encodeSlash) {
      out += '/';
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Pure Node.js AWS Signature Version 4 (`AWS4-HMAC-SHA256`) builder (RFC 3986 canonical URI & query)
 */
export function buildAwsSigV4Headers(
  input: AwsSigV4RequestInput
): AwsSigV4SignedResult {
  const method = input.method.toUpperCase();
  const parsedUrl =
    typeof input.url === 'string' ? new URL(input.url) : new URL(input.url.toString());
  const region = (input.region || 'auto').trim() || 'auto';
  const service = (input.service || 's3').trim() || 's3';
  const { amzDate, dateStamp } = formatAmzDate(input.now ?? new Date());

  const payloadHash =
    input.payloadHash ??
    (input.body !== undefined ? sha256Hex(input.body) : 'UNSIGNED-PAYLOAD');

  const rawSegments = (parsedUrl.pathname || '/').split('/');
  const canonicalUri =
    rawSegments
      .map((seg) => {
        try {
          return awsUriEncode(decodeURIComponent(seg), true);
        } catch {
          return awsUriEncode(seg, true);
        }
      })
      .join('/') || '/';

  const queryPairs: Array<[string, string]> = [];
  parsedUrl.searchParams.forEach((val, key) => {
    queryPairs.push([awsUriEncode(key, true), awsUriEncode(val, true)]);
  });
  queryPairs.sort((a, b) =>
    a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
  );
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const normalizedHeaders = new Map<string, string>();
  if (input.headers) {
    for (const [k, v] of Object.entries(input.headers)) {
      if (v === undefined || v === null) continue;
      normalizedHeaders.set(
        k.trim().toLowerCase(),
        String(v).trim().replace(/\s+/g, ' ')
      );
    }
  }
  normalizedHeaders.set('host', parsedUrl.host);
  normalizedHeaders.set('x-amz-content-sha256', payloadHash);
  normalizedHeaders.set('x-amz-date', amzDate);

  const sortedHeaderKeys = Array.from(normalizedHeaders.keys()).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${normalizedHeaders.get(k)}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri.startsWith('/') ? canonicalUri : `/${canonicalUri}`,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const outHeaders: Record<string, string> = {};
  for (const k of sortedHeaderKeys) {
    if (k === 'host') continue; // fetch() tự động gán Host header chuẩn từ URL
    outHeaders[k] = normalizedHeaders.get(k)!;
  }
  outHeaders.Authorization = authorization;

  return {
    headers: outHeaders,
    authorization,
    amzDate,
    dateStamp,
    payloadHash,
    canonicalRequest,
    stringToSign,
    signature,
  };
}

function buildS3TargetUrl(
  cfg: S3OffsiteConfig,
  objectKey = '',
  queryParams?: Record<string, string>
): URL {
  const bucket = cfg.bucket.trim();
  if (!bucket) {
    throw new Error('Tên S3 Bucket không được để trống.');
  }

  const region = (cfg.region || 'auto').trim() || 'auto';
  let rawEndpoint = cfg.endpoint.trim();
  if (!rawEndpoint) {
    if (cfg.preset === 'AWS') {
      const awsRegion = region === 'auto' ? 'us-east-1' : region;
      rawEndpoint = `https://s3.${awsRegion}.amazonaws.com`;
    } else {
      throw new Error(
        'Vui lòng nhập S3 Endpoint URL (VD: https://<accountid>.r2.cloudflarestorage.com hoặc https://s3.us-west-004.backblazeb2.com).'
      );
    }
  }
  if (!/^https?:\/\//i.test(rawEndpoint)) {
    rawEndpoint = `https://${rawEndpoint}`;
  }

  const base = new URL(rawEndpoint);
  let basePath = base.pathname.replace(/\/+$/, '');
  const cleanKey = objectKey.replace(/^\/+/, '');
  const encodedKeyPath = cleanKey
    ? cleanKey
        .split('/')
        .map((s) => encodeURIComponent(s))
        .join('/')
    : '';

  const isAwsStandardHost =
    base.hostname.endsWith('.amazonaws.com') &&
    !base.hostname.startsWith(`${bucket}.`) &&
    !bucket.includes('.');

  if (isAwsStandardHost) {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = encodedKeyPath ? `${basePath}/${encodedKeyPath}` : `${basePath}/`;
  } else {
    if (!basePath.endsWith(`/${encodeURIComponent(bucket)}`) && basePath !== `/${bucket}`) {
      basePath = `${basePath}/${encodeURIComponent(bucket)}`;
    }
    base.pathname = encodedKeyPath ? `${basePath}/${encodedKeyPath}` : basePath;
  }

  base.search = '';
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      base.searchParams.set(k, v);
    }
  }
  return base;
}

function getS3ProviderLabel(cfg: S3OffsiteConfig): string {
  if (cfg.preset === 'R2' || cfg.endpoint.includes('r2.cloudflarestorage.com')) {
    return 'Cloudflare R2';
  }
  if (cfg.preset === 'B2' || cfg.endpoint.includes('backblazeb2.com')) {
    return 'Backblaze B2';
  }
  if (cfg.preset === 'AWS' || cfg.endpoint.includes('amazonaws.com')) {
    return 'Amazon S3';
  }
  return 'S3-Compatible Object Storage';
}

function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : '';
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXmlEntities(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function validateS3Config(cfg: S3OffsiteConfig): void {
  if (!cfg.bucket.trim()) {
    throw new Error('Thiếu tên S3 Bucket.');
  }
  if (!cfg.accessKeyId.trim() || !cfg.secretAccessKey.trim()) {
    throw new Error('Thiếu S3 Access Key ID hoặc Secret Access Key.');
  }
}

async function s3SignedFetch(
  cfg: S3OffsiteConfig,
  method: string,
  objectKey: string,
  options: {
    queryParams?: Record<string, string>;
    body?: Buffer | string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<Response> {
  const targetUrl = buildS3TargetUrl(cfg, objectKey, options.queryParams);
  const bodyBuf =
    options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body, 'utf8');

  const signed = buildAwsSigV4Headers({
    method,
    url: targetUrl,
    accessKeyId: cfg.accessKeyId.trim(),
    secretAccessKey: cfg.secretAccessKey.trim(),
    region: cfg.region.trim() || 'auto',
    service: 's3',
    headers: options.headers,
    body: bodyBuf ?? '',
  });

  return fetch(targetUrl.toString(), {
    method,
    headers: signed.headers,
    body: bodyBuf ? new Uint8Array(bodyBuf) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
}

export async function testS3OffsiteConnection(cfg: S3OffsiteConfig): Promise<{
  ok: boolean;
  providerLabel: string;
  detail: string;
}> {
  validateS3Config(cfg);
  const providerLabel = getS3ProviderLabel(cfg);
  const cleanPrefix = cfg.prefix.trim().replace(/^\/+|\/+$/g, '');
  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': '1',
  };
  if (cleanPrefix) {
    query.prefix = `${cleanPrefix}/`;
  }

  const resp = await s3SignedFetch(cfg, 'GET', '', {
    queryParams: query,
    timeoutMs: 20_000,
  });
  const xml = await resp.text();
  if (!resp.ok) {
    const s3Msg = extractXmlTag(xml, 'Message') || extractXmlTag(xml, 'Code') || xml.slice(0, 200);
    throw new Error(
      `Kết nối ${providerLabel} thất bại (HTTP ${resp.status}): ${s3Msg}`
    );
  }

  return {
    ok: true,
    providerLabel,
    detail: `Đã kết nối thành công tới Bucket "${cfg.bucket.trim()}" trên ${providerLabel} (Region: ${
      cfg.region.trim() || 'auto'
    }).`,
  };
}

async function* chunkReadableStream(
  readableStream: AsyncIterable<Buffer | Uint8Array>,
  chunkSizeBytes: number
): AsyncGenerator<Buffer, void, unknown> {
  let chunks: Buffer[] = [];
  let accLen = 0;

  for await (const raw of readableStream) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length === 0) continue;
    chunks.push(buf);
    accLen += buf.length;

    while (accLen >= chunkSizeBytes) {
      const full = Buffer.concat(chunks, accLen);
      yield full.subarray(0, chunkSizeBytes);
      const rest = full.subarray(chunkSizeBytes);
      chunks = rest.length > 0 ? [rest] : [];
      accLen = rest.length;
    }
  }

  if (accLen > 0) {
    yield Buffer.concat(chunks, accLen);
  }
}

export async function uploadStreamToS3Multipart(
  cfg: S3OffsiteConfig,
  objectKey: string,
  readableStream: AsyncIterable<Buffer | Uint8Array>
): Promise<{ totalBytes: number }> {
  validateS3Config(cfg);

  const partIterator = chunkReadableStream(readableStream, MULTIPART_CHUNK_BYTES);
  const firstStep = await partIterator.next();
  const firstChunk = firstStep.done ? Buffer.alloc(0) : firstStep.value;

  const secondStep = firstStep.done ? { done: true as const, value: undefined } : await partIterator.next();

  // Nếu toàn bộ gói sao lưu <= 8 MiB (chỉ có duy nhất 1 khối), gửi trực tiếp bằng Single PUT
  if (secondStep.done) {
    const putResp = await s3SignedFetch(cfg, 'PUT', objectKey, {
      body: firstChunk,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(firstChunk.length),
      },
      timeoutMs: 300_000,
    });
    if (!putResp.ok) {
      const errXml = await putResp.text();
      throw new Error(
        `S3 PUT upload thất bại (HTTP ${putResp.status}): ${
          extractXmlTag(errXml, 'Message') || errXml.slice(0, 200)
        }`
      );
    }
    return { totalBytes: firstChunk.length };
  }

  // Luồng > 8 MiB: Khởi tạo S3 Multipart Upload
  const initResp = await s3SignedFetch(cfg, 'POST', objectKey, {
    queryParams: { uploads: '' },
    headers: { 'content-type': 'application/octet-stream' },
    timeoutMs: 30_000,
  });
  const initXml = await initResp.text();
  if (!initResp.ok) {
    throw new Error(
      `Không thể khởi tạo S3 Multipart Upload (HTTP ${initResp.status}): ${
        extractXmlTag(initXml, 'Message') || initXml.slice(0, 200)
      }`
    );
  }

  const uploadId = extractXmlTag(initXml, 'UploadId');
  if (!uploadId) {
    throw new Error('Phản hồi CreateMultipartUpload thiếu UploadId.');
  }

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let totalBytes = 0;

  const uploadSinglePart = async (partNumber: number, buf: Buffer) => {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const partResp = await s3SignedFetch(cfg, 'PUT', objectKey, {
          queryParams: {
            partNumber: String(partNumber),
            uploadId,
          },
          body: buf,
          headers: {
            'content-length': String(buf.length),
          },
          timeoutMs: 300_000,
        });
        const respBody = await partResp.text();
        if (!partResp.ok) {
          throw new Error(
            `Upload part #${partNumber} lỗi HTTP ${partResp.status}: ${
              extractXmlTag(respBody, 'Message') || respBody.slice(0, 200)
            }`
          );
        }
        const etag =
          partResp.headers.get('etag') || extractXmlTag(respBody, 'ETag');
        if (!etag) {
          throw new Error(`Upload part #${partNumber} thiếu ETag phản hồi.`);
        }
        completedParts.push({ partNumber, etag });
        totalBytes += buf.length;
        return;
      } catch (err) {
        lastErr = err as Error;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
    }
    throw lastErr || new Error(`Upload part #${partNumber} thất bại.`);
  };

  try {
    await uploadSinglePart(1, firstChunk);
    await uploadSinglePart(2, secondStep.value!);

    let nextPartNo = 3;
    for await (const partBuf of partIterator) {
      await uploadSinglePart(nextPartNo++, partBuf);
    }

    const completeXml = [
      '<CompleteMultipartUpload>',
      ...completedParts.map(
        (p) =>
          `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXmlEntities(
            p.etag
          )}</ETag></Part>`
      ),
      '</CompleteMultipartUpload>',
    ].join('');

    const compResp = await s3SignedFetch(cfg, 'POST', objectKey, {
      queryParams: { uploadId },
      body: completeXml,
      headers: { 'content-type': 'application/xml' },
      timeoutMs: 60_000,
    });
    const compBody = await compResp.text();
    if (!compResp.ok || /<Error>/i.test(compBody)) {
      throw new Error(
        `Hoàn tất S3 Multipart Upload thất bại (HTTP ${compResp.status}): ${
          extractXmlTag(compBody, 'Message') || compBody.slice(0, 200)
        }`
      );
    }

    return { totalBytes };
  } catch (err) {
    // Hủy Multipart Upload dở dang để không phát sinh phí lưu trữ rác trên S3/R2/B2
    await s3SignedFetch(cfg, 'DELETE', objectKey, {
      queryParams: { uploadId },
      timeoutMs: 20_000,
    }).catch(() => {});
    throw err;
  }
}

export async function pruneOldS3Snapshots(
  cfg: S3OffsiteConfig,
  serverHostname: string,
  keepCount: number
): Promise<{ deletedCount: number }> {
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    return { deletedCount: 0 };
  }

  const cleanPrefix = cfg.prefix.trim().replace(/^\/+|\/+$/g, '');
  const listPrefix = cleanPrefix
    ? `${cleanPrefix}/${serverHostname}/`
    : `${serverHostname}/`;

  const objects: Array<{ key: string; lastModified: string }> = [];
  let continuationToken = '';

  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = {
      'list-type': '2',
      prefix: listPrefix,
    };
    if (continuationToken) {
      query['continuation-token'] = continuationToken;
    }

    const resp = await s3SignedFetch(cfg, 'GET', '', {
      queryParams: query,
      timeoutMs: 30_000,
    });
    if (!resp.ok) break;
    const xml = await resp.text();

    const contentsMatches = xml.match(/<Contents>[\s\S]*?<\/Contents>/gi) || [];
    for (const block of contentsMatches) {
      const key = extractXmlTag(block, 'Key');
      const lastModified = extractXmlTag(block, 'LastModified');
      if (key && key.endsWith('.tar.gz.enc')) {
        objects.push({ key, lastModified });
      }
    }

    const isTruncated =
      extractXmlTag(xml, 'IsTruncated').toLowerCase() === 'true';
    const nextTok = extractXmlTag(xml, 'NextContinuationToken');
    if (!isTruncated || !nextTok) break;
    continuationToken = nextTok;
  }

  if (objects.length <= keepCount) {
    return { deletedCount: 0 };
  }

  // Sắp xếp cũ nhất lên đầu để xóa phần dôi ra ngoài keepCount
  objects.sort((a, b) => {
    const ta = Date.parse(a.lastModified) || 0;
    const tb = Date.parse(b.lastModified) || 0;
    if (ta !== tb) return ta - tb;
    return a.key.localeCompare(b.key);
  });

  const toDelete = objects.slice(0, objects.length - keepCount);
  let deletedCount = 0;
  for (const item of toDelete) {
    const delResp = await s3SignedFetch(cfg, 'DELETE', item.key, {
      timeoutMs: 20_000,
    });
    if (delResp.ok || delResp.status === 204) {
      deletedCount++;
    }
  }
  return { deletedCount };
}

/**
 * Chuẩn hóa Google Drive Folder ID (tự động bóc ID nếu quản trị viên dán nguyên đường dẫn URL)
 */
export function normalizeGoogleDriveFolderId(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';

  const folderPathMatch = trimmed.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (folderPathMatch) {
    return folderPathMatch[1];
  }

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      const idParam = parsed.searchParams.get('id');
      if (idParam && /^[A-Za-z0-9_-]{10,}$/.test(idParam)) {
        return idParam;
      }
    }
  } catch {
    // Không phải URL
  }

  const clean = trimmed.split(/[?#]/)[0].trim();
  if (!/^[A-Za-z0-9_-]+$/.test(clean)) {
    throw new Error(
      'Google Drive Folder ID chứa ký tự không hợp lệ. Vui lòng dán URL thư mục Drive hoặc chuỗi ID hợp lệ.'
    );
  }
  return clean;
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

/**
 * Sinh JWT RS256 thuần `node:crypto` cho Google Cloud Service Account
 */
export function createGoogleServiceAccountJwt(
  sa: { client_email: string; private_key: string },
  scope = 'https://www.googleapis.com/auth/drive.file',
  nowSec = Math.floor(Date.now() / 1000)
): string {
  const clientEmail = String(sa.client_email || '').trim();
  const privateKey = String(sa.private_key || '').replace(/\\n/g, '\n').trim();

  if (!clientEmail || !privateKey.includes('PRIVATE KEY')) {
    throw new Error(
      'Service Account JSON thiếu client_email hoặc private_key hợp lệ.'
    );
  }

  const headerB64 = base64UrlEncode(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  );
  const payloadB64 = base64UrlEncode(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );

  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput, 'utf8');
  signer.end();
  const sigB64 = signer.sign(privateKey).toString('base64url');

  return `${signingInput}.${sigB64}`;
}

export async function getGoogleDriveAccessToken(
  cfg: GoogleDriveOffsiteConfig
): Promise<string> {
  if (cfg.authMode === 'SERVICE_ACCOUNT') {
    const rawJson = cfg.serviceAccountJson.trim();
    if (!rawJson) {
      throw new Error(
        'Chưa cấu hình nội dung JSON của Google Cloud Service Account.'
      );
    }
    let parsedSa: { client_email?: string; private_key?: string };
    try {
      parsedSa = JSON.parse(rawJson);
    } catch {
      throw new Error('Nội dung Service Account JSON không đúng định dạng JSON.');
    }

    const assertion = createGoogleServiceAccountJwt({
      client_email: parsedSa.client_email || '',
      private_key: parsedSa.private_key || '',
    });

    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await resp.json().catch(() => ({}))) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (!resp.ok || !data.access_token) {
      throw new Error(
        `Xác thực Google Service Account thất bại: ${
          data.error_description || data.error || `HTTP ${resp.status}`
        }`
      );
    }
    return data.access_token;
  }

  // Chế độ OAUTH2 (Gmail cá nhân & Google Workspace)
  const clientId = cfg.clientId.trim();
  const clientSecret = cfg.clientSecret.trim();
  const refreshToken = cfg.refreshToken.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Thiếu Google OAuth2 Client ID, Client Secret hoặc chưa ủy quyền Refresh Token.'
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await resp.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
    error?: string;
  };
  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Đổi Google OAuth2 Access Token thất bại: ${
        data.error_description || data.error || `HTTP ${resp.status}`
      }`
    );
  }
  return data.access_token;
}

export async function testGoogleDriveConnection(
  cfg: GoogleDriveOffsiteConfig
): Promise<{
  ok: boolean;
  providerLabel: string;
  detail: string;
}> {
  const token = await getGoogleDriveAccessToken(cfg);
  const folderId = normalizeGoogleDriveFolderId(cfg.folderId);

  const aboutResp = await fetch(
    'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)',
    {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    }
  );
  const aboutJson = (await aboutResp.json().catch(() => ({}))) as {
    user?: { displayName?: string; emailAddress?: string };
    storageQuota?: { limit?: string; usage?: string };
    error?: { message?: string };
  };
  if (!aboutResp.ok) {
    throw new Error(
      `Lỗi truy vấn thông tin Google Drive (HTTP ${aboutResp.status}): ${
        aboutJson.error?.message || 'Không xác định'
      }`
    );
  }

  const email =
    aboutJson.user?.emailAddress || aboutJson.user?.displayName || 'Google Drive';
  const rawLimit = Number(aboutJson.storageQuota?.limit || 0);
  const rawUsage = Number(aboutJson.storageQuota?.usage || 0);
  const freeGb =
    rawLimit > 0
      ? Math.max(0, (rawLimit - rawUsage) / 1024 ** 3).toFixed(2)
      : 'Unlimited';

  let folderName = 'My Drive (Thư mục gốc)';
  if (folderId) {
    const folderResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        folderId
      )}?fields=id,name,trashed&supportsAllDrives=true`,
      {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }
    );
    const folderJson = (await folderResp.json().catch(() => ({}))) as {
      id?: string;
      name?: string;
      trashed?: boolean;
      error?: { message?: string };
    };
    if (!folderResp.ok || !folderJson.id) {
      throw new Error(
        `Không truy cập được thư mục Google Drive ID "${folderId}" (HTTP ${folderResp.status}): ${
          folderJson.error?.message ||
          'Hãy kiểm tra Folder ID hoặc chia sẻ quyền Editor thư mục cho tài khoản kết nối.'
        }`
      );
    }
    if (folderJson.trashed) {
      throw new Error(
        `Thư mục đích "${folderJson.name || folderId}" trên Google Drive đang nằm trong Thùng rác (Trash)!`
      );
    }
    folderName = folderJson.name || folderId;
  }

  return {
    ok: true,
    providerLabel: 'Google Drive',
    detail: `Đã kết nối tài khoản ${email} (Trống ${freeGb} GB) — Thư mục: ${folderName}`,
  };
}

export async function uploadStreamToGoogleDriveResumable(
  cfg: GoogleDriveOffsiteConfig,
  fileName: string,
  readableStream: AsyncIterable<Buffer | Uint8Array>
): Promise<{ totalBytes: number; fileId: string }> {
  const token = await getGoogleDriveAccessToken(cfg);
  const folderId = normalizeGoogleDriveFolderId(cfg.folderId);

  const metadata: Record<string, unknown> = {
    name: fileName,
    mimeType: 'application/octet-stream',
  };
  if (folderId) {
    metadata.parents = [folderId];
  }

  const initResp = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(metadata),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    }
  );

  if (!initResp.ok) {
    const errText = await initResp.text();
    throw new Error(
      `Không thể khởi tạo phiên Google Drive Resumable Upload (HTTP ${initResp.status}): ${errText.slice(
        0,
        240
      )}`
    );
  }

  const sessionUri = initResp.headers.get('location');
  if (!sessionUri) {
    throw new Error(
      'Google Drive Resumable Upload không trả về Location sessionUri.'
    );
  }

  const sendChunk = async (
    chunk: Buffer,
    offset: number,
    isFinal: boolean
  ): Promise<{ fileId?: string }> => {
    const totalLen = offset + chunk.length;
    const contentRange =
      isFinal && totalLen === 0
        ? 'bytes */0'
        : isFinal
        ? `bytes ${offset}-${totalLen - 1}/${totalLen}`
        : `bytes ${offset}-${offset + chunk.length - 1}/*`;

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const putResp = await fetch(sessionUri, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.length),
            'Content-Range': contentRange,
          },
          body: chunk.length > 0 ? new Uint8Array(chunk) : undefined,
          redirect: 'manual', // Chặn fetch tự redirect khi nhận HTTP 308 Resume Incomplete!
          cache: 'no-store',
          signal: AbortSignal.timeout(300_000),
        });

        if (!isFinal) {
          if (putResp.status === 308) {
            return {};
          }
          const txt = await putResp.text();
          throw new Error(
            `Google Drive Resumable chunk tại offset ${offset} trả về HTTP ${putResp.status} (kỳ vọng 308): ${txt.slice(
              0,
              200
            )}`
          );
        }

        if (putResp.status === 200 || putResp.status === 201) {
          const json = (await putResp.json().catch(() => ({}))) as {
            id?: string;
          };
          return { fileId: json.id || '' };
        }

        const errTxt = await putResp.text();
        throw new Error(
          `Google Drive hoàn tất Resumable Upload thất bại (HTTP ${putResp.status}): ${errTxt.slice(
            0,
            240
          )}`
        );
      } catch (err) {
        lastErr = err as Error;
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
    }
    throw lastErr || new Error('Google Drive Resumable Upload thất bại.');
  };

  // Lookahead 1 khối 8 MiB (bội số của 256 KiB) để luôn biết chính xác đâu là khối cuối cùng
  let pendingChunk: Buffer | null = null;
  let offset = 0;

  for await (const nextChunk of chunkReadableStream(
    readableStream,
    MULTIPART_CHUNK_BYTES
  )) {
    if (pendingChunk !== null) {
      await sendChunk(pendingChunk, offset, false);
      offset += pendingChunk.length;
    }
    pendingChunk = nextChunk;
  }

  if (pendingChunk === null) {
    const fin = await sendChunk(Buffer.alloc(0), 0, true);
    return { totalBytes: 0, fileId: fin.fileId || '' };
  }

  const fin = await sendChunk(pendingChunk, offset, true);
  return {
    totalBytes: offset + pendingChunk.length,
    fileId: fin.fileId || '',
  };
}

export async function pruneOldGoogleDriveSnapshots(
  cfg: GoogleDriveOffsiteConfig,
  serverHostname: string,
  keepCount: number
): Promise<{ deletedCount: number }> {
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    return { deletedCount: 0 };
  }

  const token = await getGoogleDriveAccessToken(cfg);
  const folderId = normalizeGoogleDriveFolderId(cfg.folderId);
  const safePrefix = `nas-sync-${serverHostname}-`.replace(/'/g, "\\'");

  const qParts = [`name contains '${safePrefix}'`, 'trashed = false'];
  if (folderId) {
    qParts.push(`'${folderId}' in parents`);
  }

  const listUrl = new URL('https://www.googleapis.com/drive/v3/files');
  listUrl.searchParams.set('q', qParts.join(' and '));
  listUrl.searchParams.set('orderBy', 'createdTime desc');
  listUrl.searchParams.set('pageSize', '200');
  listUrl.searchParams.set('fields', 'files(id,name,createdTime)');
  listUrl.searchParams.set('supportsAllDrives', 'true');
  listUrl.searchParams.set('includeItemsFromAllDrives', 'true');

  const resp = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(25_000),
  });
  if (!resp.ok) {
    return { deletedCount: 0 };
  }

  const data = (await resp.json().catch(() => ({}))) as {
    files?: Array<{ id: string; name: string; createdTime?: string }>;
  };
  const files = (data.files || []).filter((f) =>
    f.name.endsWith('.tar.gz.enc')
  );
  if (files.length <= keepCount) {
    return { deletedCount: 0 };
  }

  const excess = files.slice(keepCount);
  let deletedCount = 0;
  for (const f of excess) {
    const delResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        f.id
      )}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(20_000),
      }
    );
    if (delResp.ok || delResp.status === 204) {
      deletedCount++;
    }
  }
  return { deletedCount };
}

export function resolveEffectiveOffsiteSettings(
  overrides?: Record<string, string>
): {
  provider: OffsiteProviderType;
  autoPush: 'NONE' | 'WEEKLY_SUNDAY' | 'EVERY_BACKUP';
  keepCount: number;
  passphrase: string;
  s3: S3OffsiteConfig;
  gdrive: GoogleDriveOffsiteConfig;
} {
  const merged = { ...getAllSettings() };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined || v === null) continue;
      const str = String(v);
      if (str === SECRET_MASK) continue;
      merged[k] = str;
    }
  }

  const rawProvider = (merged.offsite_provider || 'NONE').trim().toUpperCase();
  const provider: OffsiteProviderType =
    rawProvider === 'S3_COMPATIBLE' || rawProvider === 'GOOGLE_DRIVE'
      ? rawProvider
      : 'NONE';

  const rawAuto = (merged.offsite_auto_push || 'NONE').trim().toUpperCase();
  const autoPush =
    rawAuto === 'EVERY_BACKUP' || rawAuto === 'WEEKLY_SUNDAY'
      ? rawAuto
      : 'NONE';

  const parsedKeep = parseInt(merged.offsite_keep_count || '12', 10);
  const keepCount =
    Number.isFinite(parsedKeep) && parsedKeep >= 1 ? parsedKeep : 12;

  const rawPreset = (merged.offsite_s3_preset || 'R2').trim().toUpperCase();
  const s3Preset: S3OffsiteConfig['preset'] =
    rawPreset === 'B2' || rawPreset === 'AWS' || rawPreset === 'CUSTOM'
      ? rawPreset
      : 'R2';

  const rawGdriveMode = (merged.offsite_gdrive_auth_mode || 'OAUTH2')
    .trim()
    .toUpperCase();

  return {
    provider,
    autoPush,
    keepCount,
    passphrase: merged.offsite_encryption_passphrase || '',
    s3: {
      preset: s3Preset,
      endpoint: merged.offsite_s3_endpoint || '',
      region: merged.offsite_s3_region || 'auto',
      bucket: merged.offsite_s3_bucket || '',
      prefix: merged.offsite_s3_prefix ?? 'nas-sync',
      accessKeyId: merged.offsite_s3_access_key || '',
      secretAccessKey: merged.offsite_s3_secret_key || '',
    },
    gdrive: {
      authMode:
        rawGdriveMode === 'SERVICE_ACCOUNT' ? 'SERVICE_ACCOUNT' : 'OAUTH2',
      folderId: merged.offsite_gdrive_folder_id || '',
      clientId: merged.offsite_gdrive_client_id || '',
      clientSecret: merged.offsite_gdrive_client_secret || '',
      refreshToken: merged.offsite_gdrive_refresh_token || '',
      serviceAccountJson: merged.offsite_gdrive_service_account_json || '',
    },
  };
}

export async function testOffsiteConnection(
  overrides?: Record<string, string>
): Promise<{
  ok: boolean;
  providerLabel: string;
  detail: string;
}> {
  const cfg = resolveEffectiveOffsiteSettings(overrides);
  if (cfg.provider === 'NONE') {
    throw new Error(
      'Vui lòng chọn nhà cung cấp Offsite Cloud (S3 / Cloudflare R2 / Backblaze B2 hoặc Google Drive) trước khi kiểm tra kết nối.'
    );
  }
  if (cfg.provider === 'S3_COMPATIBLE') {
    return testS3OffsiteConnection(cfg.s3);
  }
  return testGoogleDriveConnection(cfg.gdrive);
}

function getOffsiteJobById(id: number): OffsiteSyncJob {
  const row = getDb()
    .prepare(
      `SELECT o.*, s.hostname AS server_hostname
       FROM offsite_sync_jobs o
       LEFT JOIN servers s ON s.id = o.server_id
       WHERE o.id = ?`
    )
    .get(id);
  return row as unknown as OffsiteSyncJob;
}

/**
 * Khởi tạo tiến trình đẩy Snapshot lên Offsite Cloud (hỗ trợ cả await đồng bộ từ Worker hoặc chạy nền từ API)
 */
export function startSnapshotOffsitePush(
  backupJobId: number,
  opts: { triggerSource?: string } = {}
): { offsiteJobId: number; completion: Promise<OffsiteSyncJob> } {
  const cfg = resolveEffectiveOffsiteSettings();
  if (cfg.provider === 'NONE') {
    throw new Error(
      'Chưa bật cấu hình Offsite Cloud Backup trong phần Cài đặt Hệ thống.'
    );
  }
  if (cfg.passphrase.length < 8) {
    throw new Error(
      'Mật khẩu mã hóa Offsite (AES-256-GCM) phải có tối thiểu 8 ký tự.'
    );
  }

  const db = getDb();
  const jobRow = db
    .prepare('SELECT id, server_id, snapshot_name, status FROM backup_jobs WHERE id = ?')
    .get(backupJobId) as
    | { id: number; server_id: number; snapshot_name: string; status: string }
    | undefined;

  if (!jobRow) {
    throw new Error(`Không tìm thấy Backup Job #${backupJobId}.`);
  }

  const { snapshotRoot, hostname, snapshotName } =
    resolveSafeSnapshotRoot(backupJobId);
  assertSafe(isSafeServerLabel, hostname, 'Server Hostname');
  assertSafe(isSafeSnapshotName, snapshotName, 'Snapshot Name');

  if (!fs.existsSync(snapshotRoot) || !fs.lstatSync(snapshotRoot).isDirectory()) {
    throw new Error(
      `Thư mục Snapshot "${snapshotName}" của ${hostname} không tồn tại trên ổ cứng NAS.`
    );
  }

  const archiveFileName = `nas-sync-${hostname}-${snapshotName}.tar.gz.enc`;
  const cleanPrefix = cfg.s3.prefix.trim().replace(/^\/+|\/+$/g, '');
  const normalizedFolderId =
    cfg.provider === 'GOOGLE_DRIVE'
      ? normalizeGoogleDriveFolderId(cfg.gdrive.folderId)
      : '';

  const remoteObjectKey =
    cfg.provider === 'S3_COMPATIBLE'
      ? cleanPrefix
        ? `${cleanPrefix}/${hostname}/${archiveFileName}`
        : `${hostname}/${archiveFileName}`
      : normalizedFolderId
      ? `${normalizedFolderId}/${archiveFileName}`
      : archiveFileName;

  const ins = db
    .prepare(
      `INSERT INTO offsite_sync_jobs
       (backup_job_id, server_id, snapshot_name, provider, remote_object_key, status)
       VALUES (?, ?, ?, ?, ?, 'UPLOADING')`
    )
    .run(
      backupJobId,
      Number(jobRow.server_id),
      snapshotName,
      cfg.provider,
      remoteObjectKey
    );

  const offsiteJobId = Number(ins.lastInsertRowid);
  const startedAtMs = Date.now();

  const completion = (async (): Promise<OffsiteSyncJob> => {
    const hostDir = path.dirname(snapshotRoot);
    const entryName = snapshotName.startsWith('-')
      ? `./${snapshotName}`
      : snapshotName;
    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const tarArgs = [
      '-czf',
      '-',
      '--exclude=.rsync-partial',
      '--exclude=.state.json',
      '-C',
      hostDir,
      entryName,
    ];

    const tarChild = spawn(tarBin, tarArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let tarStderr = '';
    tarChild.stderr.on('data', (d: Buffer) => {
      if (tarStderr.length < 4096) {
        tarStderr += d.toString('utf8');
      }
    });

    const encryptStream = createOffsiteEncryptStream(cfg.passphrase);

    const tarExitPromise = new Promise<void>((resolve, reject) => {
      tarChild.on('error', (err) => {
        encryptStream.destroy(err);
        reject(err);
      });
      tarChild.on('close', (code) => {
        if (code !== 0) {
          const err = new Error(
            `Đóng gói luồng tar.gz cho Snapshot "${snapshotName}" thất bại (code ${code}): ${tarStderr.trim()}`
          );
          encryptStream.destroy(err);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    tarChild.stdout.pipe(encryptStream);

    try {
      let uploadedBytes = 0;
      let finalRemoteKey = remoteObjectKey;

      if (cfg.provider === 'S3_COMPATIBLE') {
        const [upRes] = await Promise.all([
          uploadStreamToS3Multipart(cfg.s3, remoteObjectKey, encryptStream),
          tarExitPromise,
        ]);
        uploadedBytes = upRes.totalBytes;
        await pruneOldS3Snapshots(cfg.s3, hostname, cfg.keepCount).catch(
          (err) => {
            console.warn('[Offsite S3 Prune Warning]:', err);
          }
        );
      } else {
        const [upRes] = await Promise.all([
          uploadStreamToGoogleDriveResumable(
            cfg.gdrive,
            archiveFileName,
            encryptStream
          ),
          tarExitPromise,
        ]);
        uploadedBytes = upRes.totalBytes;
        if (upRes.fileId) {
          finalRemoteKey = `${archiveFileName} (${upRes.fileId})`;
        }
        await pruneOldGoogleDriveSnapshots(
          cfg.gdrive,
          hostname,
          cfg.keepCount
        ).catch((err) => {
          console.warn('[Offsite Google Drive Prune Warning]:', err);
        });
      }

      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - startedAtMs) / 1000)
      );

      db.prepare(
        `UPDATE offsite_sync_jobs
         SET status = 'COMPLETED',
             remote_object_key = ?,
             encrypted_size_bytes = ?,
             duration_seconds = ?,
             error_message = NULL,
             completed_at = datetime('now')
         WHERE id = ?`
      ).run(finalRemoteKey, uploadedBytes, durationSeconds, offsiteJobId);

      const providerLabel =
        cfg.provider === 'S3_COMPATIBLE'
          ? getS3ProviderLabel(cfg.s3)
          : 'Google Drive';

      await createSystemAlert({
        severity: 'INFO',
        category: 'BACKUP',
        serverId: Number(jobRow.server_id),
        jobId: backupJobId,
        title: `Đã đẩy bản sao lưu mã hóa Offsite lên ${providerLabel}`,
        message: `Snapshot ${hostname}@${snapshotName} đã được mã hóa AES-256-GCM và tải lên ${providerLabel} thành công (${(
          uploadedBytes /
          1024 ** 2
        ).toFixed(2)} MB trong ${durationSeconds}s${
          opts.triggerSource ? ` — nguồn: ${opts.triggerSource}` : ''
        }).`,
        notifyExternal: false,
      });

      return getOffsiteJobById(offsiteJobId);
    } catch (err) {
      try {
        if (tarChild.exitCode === null) {
          tarChild.kill('SIGTERM');
        }
      } catch {
        // Ignore
      }

      const durationSeconds = Math.max(
        1,
        Math.round((Date.now() - startedAtMs) / 1000)
      );
      const errMsg = (err as Error).message || 'Lỗi đồng bộ Offsite không xác định';

      db.prepare(
        `UPDATE offsite_sync_jobs
         SET status = 'FAILED',
             duration_seconds = ?,
             error_message = ?,
             completed_at = datetime('now')
         WHERE id = ?`
      ).run(durationSeconds, errMsg, offsiteJobId);

      await createSystemAlert({
        severity: 'WARNING',
        category: 'BACKUP',
        serverId: Number(jobRow.server_id),
        jobId: backupJobId,
        title: `Đồng bộ Offsite Cloud thất bại (${hostname})`,
        message: `Không thể đẩy bản sao lưu ${snapshotName} lên ${cfg.provider}: ${errMsg}. Bản sao lưu nội bộ trên NAS vẫn an toàn.`,
      });

      throw err;
    }
  })();

  return { offsiteJobId, completion };
}

export async function pushSnapshotToOffsiteCloud(
  backupJobId: number,
  opts?: { triggerSource?: string }
): Promise<OffsiteSyncJob> {
  const { completion } = startSnapshotOffsitePush(backupJobId, opts);
  return completion;
}

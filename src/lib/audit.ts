import type { NextRequest } from 'next/server';
import { getDb } from './db';
import type { SessionPayload } from './jwt-edge';

const MAX_AUDIT_ROWS = 5000;

type HeaderCarrier =
  | NextRequest
  | { headers?: Headers | Record<string, string | string[] | undefined> }
  | null
  | undefined;

function readHeaderValue(carrier: HeaderCarrier, key: string): string {
  if (!carrier || !carrier.headers) return '';
  const h = carrier.headers;
  if (typeof (h as Headers).get === 'function') {
    return ((h as Headers).get(key) || '').trim();
  }
  const rec = h as Record<string, string | string[] | undefined>;
  const raw = rec[key] ?? rec[key.toLowerCase()];
  if (Array.isArray(raw)) {
    return (raw[0] || '').trim();
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizeIp(rawIp: string): string {
  const trimmed = rawIp.trim();
  if (!trimmed) return 'local-client';
  if (trimmed.startsWith('::ffff:') && /^\d+\.\d+\.\d+\.\d+$/.test(trimmed.slice(7))) {
    return trimmed.slice(7);
  }
  return trimmed.slice(0, 128);
}

export function extractRequestIp(req?: HeaderCarrier): string {
  if (!req) return 'local-client';

  const socketIp = readHeaderValue(req, 'x-nas-client-ip');
  if (process.env.TRUST_PROXY === 'true') {
    const xff = readHeaderValue(req, 'x-forwarded-for');
    if (xff) {
      const hops = xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (hops.length > 0) {
        return normalizeIp(hops[hops.length - 1]);
      }
    }
    const realIp = readHeaderValue(req, 'x-real-ip');
    if (realIp) {
      return normalizeIp(realIp);
    }
  }

  return normalizeIp(socketIp || 'local-client');
}

export interface RecordAuditLogParams {
  session?: SessionPayload | null;
  userId?: number | null;
  username?: string;
  action: string;
  resourceType?: string;
  resourceId?: string | number | null;
  detail?: string;
  ipAddress?: string;
  req?: HeaderCarrier;
}

export function recordAuditLog(params: RecordAuditLogParams): void {
  try {
    const db = getDb();
    const resolvedUserId =
      params.userId !== undefined
        ? params.userId
        : params.session?.userId ?? null;
    const resolvedUsername =
      (params.username || params.session?.username || 'system')
        .trim()
        .slice(0, 64) || 'system';
    const resolvedAction = String(params.action || 'UNKNOWN')
      .trim()
      .slice(0, 64);
    const resolvedResourceType = String(params.resourceType || 'SYSTEM')
      .trim()
      .slice(0, 64);
    const resolvedResourceId =
      params.resourceId !== undefined && params.resourceId !== null
        ? String(params.resourceId).slice(0, 128)
        : null;
    const resolvedDetail = String(params.detail || '').slice(0, 1024);
    const resolvedIp =
      params.ipAddress !== undefined
        ? normalizeIp(params.ipAddress)
        : extractRequestIp(params.req);

    db.prepare(
      `INSERT INTO audit_logs
       (user_id, username, action, resource_type, resource_id, detail, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      resolvedUserId,
      resolvedUsername,
      resolvedAction,
      resolvedResourceType,
      resolvedResourceId,
      resolvedDetail,
      resolvedIp
    );

    const totalCount = Number(
      db.prepare('SELECT COUNT(*) AS cnt FROM audit_logs').get()?.cnt || 0
    );
    if (totalCount > MAX_AUDIT_ROWS) {
      db.prepare(
        `DELETE FROM audit_logs
         WHERE id NOT IN (
           SELECT id FROM audit_logs ORDER BY id DESC LIMIT ?
         )`
      ).run(MAX_AUDIT_ROWS);
    }
  } catch (err) {
    console.warn('[NAS-Sync Audit] Không thể ghi nhật ký kiểm toán:', err);
  }
}

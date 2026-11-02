import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import type { AuditLogRecord } from '@/types';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(500, Math.max(1, Number(sp.get('limit') || 100)));
  const action = (sp.get('action') || '').trim();
  const username = (sp.get('username') || '').trim();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (username) {
    conditions.push('username = ?');
    params.push(username);
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = getDb()
    .prepare(
      `SELECT id, user_id, username, action, resource_type, resource_id, detail, ip_address, created_at
       FROM audit_logs
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  const logs: AuditLogRecord[] = rows.map((r) => ({
    id: Number(r.id),
    user_id: r.user_id !== null && r.user_id !== undefined ? Number(r.user_id) : null,
    username: String(r.username || ''),
    action: String(r.action || ''),
    resource_type: String(r.resource_type || 'SYSTEM'),
    resource_id:
      r.resource_id !== null && r.resource_id !== undefined
        ? String(r.resource_id)
        : null,
    detail: String(r.detail || ''),
    ip_address: String(r.ip_address || ''),
    created_at: String(r.created_at || ''),
  }));

  return NextResponse.json({ logs });
}

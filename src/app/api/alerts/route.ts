import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import type { SystemAlert } from '@/types';

const VALID_SEVERITIES = new Set(['INFO', 'WARNING', 'CRITICAL']);
const VALID_CATEGORIES = new Set([
  'VOLUME',
  'ANOMALY',
  'BACKUP',
  'RESTORE',
  'BTRFS',
  'SYSTEM',
]);

export async function GET(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
    if (!guard.ok) return guard.response;

    const sp = req.nextUrl.searchParams;
    const limit = Math.min(500, Math.max(1, Number(sp.get('limit') || 200)));
    const severity = (sp.get('severity') || '').trim().toUpperCase();
    const category = (sp.get('category') || '').trim().toUpperCase();
    const unreadOnly = sp.get('unread') === '1' || sp.get('unread') === 'true';

    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (severity && VALID_SEVERITIES.has(severity)) {
      conditions.push('severity = ?');
      params.push(severity);
    }
    if (category && VALID_CATEGORIES.has(category)) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (unreadOnly) {
      conditions.push('is_read = 0');
    }

    const whereSql =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT id, severity, category, title, message, server_id, job_id, is_read, created_at
         FROM system_alerts
         ${whereSql}
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(...params, limit);

    const alerts: SystemAlert[] = rows.map((r) => ({
      id: Number(r.id),
      severity: (String(r.severity || 'INFO') as SystemAlert['severity']),
      category: (String(r.category || 'SYSTEM') as SystemAlert['category']),
      title: String(r.title || ''),
      message: String(r.message || ''),
      server_id:
        r.server_id !== null && r.server_id !== undefined
          ? Number(r.server_id)
          : null,
      job_id:
        r.job_id !== null && r.job_id !== undefined ? Number(r.job_id) : null,
      is_read: Number(r.is_read || 0),
      created_at: String(r.created_at || ''),
    }));

    const countsRow = db
      .prepare(
        `SELECT
           COUNT(*) AS total_count,
           IFNULL(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread_count,
           IFNULL(SUM(CASE WHEN is_read = 0 AND severity = 'CRITICAL' THEN 1 ELSE 0 END), 0) AS critical_unread_count,
           IFNULL(SUM(CASE WHEN severity = 'CRITICAL' THEN 1 ELSE 0 END), 0) AS critical_count,
           IFNULL(SUM(CASE WHEN severity = 'WARNING' THEN 1 ELSE 0 END), 0) AS warning_count,
           IFNULL(SUM(CASE WHEN severity = 'INFO' THEN 1 ELSE 0 END), 0) AS info_count
         FROM system_alerts`
      )
      .get();

    return NextResponse.json({
      alerts,
      summary: {
        totalCount: Number(countsRow?.total_count || 0),
        unreadCount: Number(countsRow?.unread_count || 0),
        criticalUnreadCount: Number(countsRow?.critical_unread_count || 0),
        criticalCount: Number(countsRow?.critical_count || 0),
        warningCount: Number(countsRow?.warning_count || 0),
        infoCount: Number(countsRow?.info_count || 0),
      },
    });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải danh sách nhật ký và cảnh báo.');
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();
    const db = getDb();

    if (action === 'mark_all_read') {
      const guard = await requireRole(
        ['ADMIN', 'OPERATOR'],
        'Tài khoản VIEWER không có quyền thay đổi trạng thái cảnh báo.'
      );
      if (!guard.ok) return guard.response;

      const res = db
        .prepare('UPDATE system_alerts SET is_read = 1 WHERE is_read = 0')
        .run();
      return NextResponse.json({
        ok: true,
        updated: Number(res.changes || 0),
      });
    }

    if (action === 'mark_read') {
      const guard = await requireRole(
        ['ADMIN', 'OPERATOR'],
        'Tài khoản VIEWER không có quyền thay đổi trạng thái cảnh báo.'
      );
      if (!guard.ok) return guard.response;

      const alertId = Number(body.alertId);
      if (!Number.isInteger(alertId) || alertId <= 0) {
        return NextResponse.json(
          { error: 'Thiếu hoặc sai mã cảnh báo alertId.' },
          { status: 400 }
        );
      }

      db.prepare('UPDATE system_alerts SET is_read = 1 WHERE id = ?').run(
        alertId
      );
      return NextResponse.json({ ok: true });
    }

    if (action === 'clear_read') {
      const guard = await requireRole(
        ['ADMIN'],
        'Chỉ quản trị viên ADMIN mới có quyền dọn dẹp lịch sử cảnh báo.'
      );
      if (!guard.ok) return guard.response;

      const res = db
        .prepare('DELETE FROM system_alerts WHERE is_read = 1')
        .run();
      const deleted = Number(res.changes || 0);
      if (deleted > 0) {
        recordAuditLog({
          session: guard.session,
          action: 'ALERTS_CLEAR_READ',
          resourceType: 'ALERTS',
          detail: `Dọn dẹp ${deleted} thông báo cảnh báo đã đọc`,
          req,
        });
      }
      return NextResponse.json({ ok: true, deleted });
    }

    return NextResponse.json(
      { error: 'Hành động không hợp lệ.' },
      { status: 400 }
    );
  } catch (err) {
    return safeErrorJson(err, 'Không thể cập nhật trạng thái cảnh báo.');
  }
}

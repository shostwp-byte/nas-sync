import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { enqueueServerBackup } from '@/lib/engine/queue';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
  if (!guard.ok) return guard.response;

  const sp = req.nextUrl.searchParams;
  const serverId = sp.get('serverId');
  const status = sp.get('status');
  const jobType = sp.get('jobType');
  const limit = Math.min(200, Number(sp.get('limit') || 60));

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (serverId) {
    conditions.push('j.server_id = ?');
    params.push(Number(serverId));
  }
  if (status) {
    conditions.push('j.status = ?');
    params.push(status);
  }
  if (jobType) {
    conditions.push('j.job_type = ?');
    params.push(jobType);
  }

  const whereSql =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const jobs = getDb()
    .prepare(
      `SELECT
         j.*,
         s.hostname AS server_hostname,
         s.panel_type AS server_panel,
         ts.hostname AS target_server_hostname,
         v.name AS volume_name,
         v.mount_path AS volume_mount_path,
         (SELECT COUNT(*) FROM backup_items bi WHERE bi.job_id = j.id) AS domains_count,
         (SELECT COUNT(*) FROM backup_items bi WHERE bi.job_id = j.id AND bi.verification_status = 'PASSED') AS verified_domains_count
       FROM backup_jobs j
       LEFT JOIN servers s ON s.id = j.server_id
       LEFT JOIN servers ts ON ts.id = j.target_server_id
       LEFT JOIN storage_volumes v ON v.id = j.volume_id
       ${whereSql}
       ORDER BY j.id DESC
       LIMIT ?`
    )
    .all(...params, limit);

  return NextResponse.json({ jobs });
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const serverId = Number(body.serverId);
    const verifyDb = body.verifyDb !== false;

    if (!serverId) {
      return NextResponse.json(
        { error: 'Thiếu tham số serverId.' },
        { status: 400 }
      );
    }

    const jobId = await enqueueServerBackup({ serverId, verifyDb });
    const srv = getDb()
      .prepare('SELECT hostname FROM servers WHERE id = ?')
      .get(serverId);

    recordAuditLog({
      session: guard.session,
      action: 'JOB_BACKUP_ENQUEUE',
      resourceType: 'JOB',
      resourceId: String(jobId),
      detail: `Kích hoạt sao lưu thủ công máy chủ "${
        srv?.hostname || `Server #${serverId}`
      }"`,
      req,
    });

    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

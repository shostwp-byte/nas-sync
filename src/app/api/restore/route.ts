import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { enqueueRestoreOperation } from '@/lib/engine/queue';
import type { RestoreRequestPayload } from '@/types';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
  if (!guard.ok) return guard.response;

  const serverId = req.nextUrl.searchParams.get('serverId');
  const db = getDb();

  const whereClause = serverId
    ? `WHERE j.job_type = 'BACKUP' AND j.status = 'COMPLETED' AND bi.server_id = ?`
    : `WHERE j.job_type = 'BACKUP' AND j.status = 'COMPLETED'`;

  const params = serverId ? [Number(serverId)] : [];

  const rows = db
    .prepare(
      `SELECT
         bi.*,
         s.hostname AS server_hostname,
         s.panel_type AS server_panel,
         v.name AS volume_name,
         v.mount_path AS volume_mount_path,
         j.completed_at,
         j.anomaly_detected
       FROM backup_items bi
       JOIN backup_jobs j ON j.id = bi.job_id
       JOIN servers s ON s.id = bi.server_id
       JOIN storage_volumes v ON v.id = bi.volume_id
       ${whereClause}
       ORDER BY j.id DESC, bi.domain_name ASC
       LIMIT 300`
    )
    .all(...params);

  const items = rows.map((r) => ({
    ...r,
    databases_list: JSON.parse(String(r.databases_list || '[]')),
  }));

  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const rawBody = (await req.json()) as RestoreRequestPayload;
    if (!rawBody.backupItemId || !rawBody.targetServerId || !rawBody.mode) {
      return NextResponse.json(
        {
          error:
            'Vui lòng chọn đầy đủ Bản sao lưu Domain, Chế độ khôi phục và Máy chủ đích.',
        },
        { status: 400 }
      );
    }

    const payload: RestoreRequestPayload = {
      ...rawBody,
      autoPatchConfig: Boolean(rawBody.autoPatchConfig),
    };

    const jobId = await enqueueRestoreOperation(payload);

    const db = getDb();
    const item = db
      .prepare('SELECT domain_name, snapshot_name FROM backup_items WHERE id = ?')
      .get(payload.backupItemId);
    const targetSrv = db
      .prepare('SELECT hostname FROM servers WHERE id = ?')
      .get(payload.targetServerId);

    recordAuditLog({
      session: guard.session,
      action: 'RESTORE_ENQUEUE',
      resourceType: 'JOB',
      resourceId: String(jobId),
      detail: `Khởi tạo khôi phục ${payload.mode} cho "${
        item?.domain_name || `#${payload.backupItemId}`
      }" (${item?.snapshot_name || ''}) ➔ ${
        targetSrv?.hostname || `Server #${payload.targetServerId}`
      }${payload.autoPatchConfig ? ' [Auto-Patch Config: ON]' : ''}`,
      req,
    });

    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    return safeErrorJson(err, 'Không thể khởi tạo tiến trình khôi phục.', 500);
  }
}

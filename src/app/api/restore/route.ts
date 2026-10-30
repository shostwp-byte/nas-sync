import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueRestoreOperation } from '@/lib/engine/queue';
import type { RestoreRequestPayload } from '@/types';

export async function GET(req: NextRequest) {
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
    const body = (await req.json()) as RestoreRequestPayload;
    if (!body.backupItemId || !body.targetServerId || !body.mode) {
      return NextResponse.json(
        {
          error:
            'Vui lòng chọn đầy đủ Bản sao lưu Domain, Chế độ khôi phục và Máy chủ đích.',
        },
        { status: 400 }
      );
    }

    const jobId = await enqueueRestoreOperation(body);
    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


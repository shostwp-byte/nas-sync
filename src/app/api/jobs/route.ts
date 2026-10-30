import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { enqueueServerBackup } from '@/lib/engine/queue';

export async function GET(req: NextRequest) {
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
    return NextResponse.json({ ok: true, jobId });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


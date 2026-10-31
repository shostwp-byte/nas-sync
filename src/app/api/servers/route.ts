import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validateServerConnectionFields } from '@/lib/engine/safe-names';

export async function GET() {
  const servers = getDb()
    .prepare(
      `SELECT
         s.*,
         v.name AS assigned_volume_name,
         v.mount_path AS assigned_volume_path,
         (SELECT COUNT(*) FROM backup_jobs j WHERE j.server_id = s.id AND j.job_type = 'BACKUP' AND j.status = 'COMPLETED') AS snapshots_count,
         (SELECT MAX(completed_at) FROM backup_jobs j WHERE j.server_id = s.id AND j.job_type = 'BACKUP' AND j.status = 'COMPLETED') AS last_backup_at
       FROM servers s
       LEFT JOIN storage_volumes v ON v.id = s.assigned_volume_id
       ORDER BY s.id DESC`
    )
    .all();

  return NextResponse.json({ servers });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const hostname = String(body.hostname || '').trim();
    const ipAddress = String(body.ip_address || '').trim();
    const sshPort = Number(body.ssh_port || 22);
    const sshUser = String(body.ssh_user || 'root').trim();
    const sshKeyPath = String(body.ssh_key_path || '').trim();
    const panelType = String(body.panel_type || 'DIRECTADMIN');
    const bwLimit = Number(body.bw_limit_kbps ?? 25600);
    const isMock = body.is_mock ? 1 : 0;
    const notes = String(body.notes || '');

    if (!hostname || !ipAddress) {
      return NextResponse.json(
        { error: 'Hostname và địa chỉ IP máy chủ VPS là bắt buộc.' },
        { status: 400 }
      );
    }

    const invalidField = validateServerConnectionFields({ hostname, ipAddress, sshUser });
    if (invalidField) {
      return NextResponse.json({ error: invalidField }, { status: 400 });
    }

    const db = getDb();
    let assignedVolId = body.assigned_volume_id
      ? Number(body.assigned_volume_id)
      : null;

    if (!assignedVolId) {
      const defVol = db
        .prepare(
          `SELECT id FROM storage_volumes WHERE status = 'ACTIVE' ORDER BY priority ASC LIMIT 1`
        )
        .get();
      assignedVolId = defVol ? Number(defVol.id) : null;
    }

    const res = db
      .prepare(
        `INSERT INTO servers
         (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, panel_type, assigned_volume_id, bw_limit_kbps, status, is_mock, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ONLINE', ?, ?)`
      )
      .run(
        hostname,
        ipAddress,
        sshPort,
        sshUser,
        sshKeyPath,
        panelType,
        assignedVolId,
        bwLimit,
        isMock,
        notes
      );

    return NextResponse.json({
      ok: true,
      serverId: Number(res.lastInsertRowid),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


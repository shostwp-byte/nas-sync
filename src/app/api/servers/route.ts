import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson, sanitizeErrorMessage } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { validateExcludePatternsInput } from '@/lib/engine/exclude-rules';
import { validateServerConnectionFields } from '@/lib/engine/safe-names';
import { MOCK_HOST_KEY_FINGERPRINT, resolveValidatedSshKeyPath } from '@/lib/ssh';

export async function GET() {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR', 'VIEWER']);
    if (!guard.ok) return guard.response;

    const rawServers = getDb()
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

    const servers = rawServers.map((row) => {
      const copy: Record<string, unknown> = { ...row };
      delete copy.known_host_entry;
      delete copy.host_key_pending_entry;
      if (guard.session.role === 'VIEWER') {
        copy.ssh_key_path = '';
      }
      return copy;
    });

    return NextResponse.json({ servers });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải danh sách máy chủ VPS.');
  }
}

function toBitFlag(val: unknown, fallback = 0): number {
  if (val === undefined || val === null) return fallback ? 1 : 0;
  return val === true || val === 1 || val === '1' || val === 'true' ? 1 : 0;
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const hostname = String(body.hostname || '').trim();
    const ipAddress = String(body.ip_address || '').trim();
    const sshPort = Number(body.ssh_port ?? 22);
    const sshUser = String(body.ssh_user || 'root').trim();
    const rawSshKeyPath = String(body.ssh_key_path || '').trim();
    const panelType = String(body.panel_type || 'DIRECTADMIN').trim();
    const bwLimit = Number(body.bw_limit_kbps ?? 25600);
    const isMock = body.is_mock ? 1 : 0;
    const notes = String(body.notes || '');
    const rawCustomExcludes =
      body.custom_excludes !== undefined ? String(body.custom_excludes) : '';
    const backupMailboxes = toBitFlag(body.backup_mailboxes, 0);
    const backupCronjobs = toBitFlag(body.backup_cronjobs, 0);
    const backupVhostConfigs = toBitFlag(body.backup_vhost_configs, 0);

    if (!hostname || !ipAddress) {
      return NextResponse.json(
        { error: 'Hostname và địa chỉ IP máy chủ VPS là bắt buộc.' },
        { status: 400 }
      );
    }

    const invalidField = validateServerConnectionFields({
      hostname,
      ipAddress,
      sshUser,
      panelType,
      sshPort,
      bwLimitKbps: bwLimit,
    });
    if (invalidField) {
      return NextResponse.json({ error: invalidField }, { status: 400 });
    }

    const excludeCheck = validateExcludePatternsInput(rawCustomExcludes);
    if (!excludeCheck.ok) {
      return NextResponse.json(
        { error: excludeCheck.error || 'Quy tắc loại trừ không hợp lệ.' },
        { status: 400 }
      );
    }

    let sshKeyPath = '';
    if (rawSshKeyPath) {
      try {
        sshKeyPath = resolveValidatedSshKeyPath(rawSshKeyPath);
      } catch (err) {
        return NextResponse.json(
          { error: sanitizeErrorMessage(err, 'Đường dẫn khóa SSH không hợp lệ.') },
          { status: 400 }
        );
      }
      if (!fs.existsSync(sshKeyPath)) {
        return NextResponse.json(
          {
            error:
              'Không tìm thấy tệp khóa SSH được chỉ định trong thư mục SSH Keys.',
          },
          { status: 400 }
        );
      }
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

    const initialHostKeyStatus = isMock ? 'VERIFIED' : 'UNPINNED';
    const initialHostKeyFp = isMock ? MOCK_HOST_KEY_FINGERPRINT : '';

    const res = db
      .prepare(
        `INSERT INTO servers
         (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, panel_type, assigned_volume_id, bw_limit_kbps, status, is_mock, notes, custom_excludes, backup_mailboxes, backup_cronjobs, backup_vhost_configs, host_key_status, host_key_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ONLINE', ?, ?, ?, ?, ?, ?, ?, ?)`
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
        notes,
        excludeCheck.normalized,
        backupMailboxes,
        backupCronjobs,
        backupVhostConfigs,
        initialHostKeyStatus,
        initialHostKeyFp
      );

    const serverId = Number(res.lastInsertRowid);

    recordAuditLog({
      session: guard.session,
      action: 'SERVER_CREATE',
      resourceType: 'SERVER',
      resourceId: String(serverId),
      detail: `Thêm máy chủ VPS "${hostname}" (${ipAddress}:${sshPort} - ${panelType})`,
      req,
    });

    return NextResponse.json({
      ok: true,
      serverId,
    });
  } catch (err) {
    return safeErrorJson(err, 'Không thể thêm máy chủ VPS mới.');
  }
}

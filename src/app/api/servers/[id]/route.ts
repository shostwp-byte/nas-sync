import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson, sanitizeErrorMessage } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { validateExcludePatternsInput } from '@/lib/engine/exclude-rules';
import { validateServerConnectionFields } from '@/lib/engine/safe-names';
import {
  MOCK_HOST_KEY_FINGERPRINT,
  removeServerKnownHostsCache,
  resolveValidatedSshKeyPath,
} from '@/lib/ssh';

function toBitFlag(val: unknown, fallback = 0): number {
  if (val === undefined || val === null) return fallback ? 1 : 0;
  return val === true || val === 1 || val === '1' || val === 'true' ? 1 : 0;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const serverId = Number(id);
    const body = await req.json();
    const db = getDb();
    const curr = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId);

    if (!curr) {
      return NextResponse.json(
        { error: 'Không tìm thấy máy chủ VPS.' },
        { status: 404 }
      );
    }

    const nextHostname = String(body.hostname ?? curr.hostname).trim();
    const nextIp = String(body.ip_address ?? curr.ip_address).trim();
    const nextSshUser = String(body.ssh_user ?? curr.ssh_user).trim();
    const nextPanelType = String(body.panel_type ?? curr.panel_type).trim();
    const nextSshPort = Number(body.ssh_port ?? curr.ssh_port);
    const nextBwLimit = Number(body.bw_limit_kbps ?? curr.bw_limit_kbps);
    const nextIsMock =
      body.is_mock !== undefined ? (body.is_mock ? 1 : 0) : Number(curr.is_mock || 0);
    const nextBackupMailboxes = toBitFlag(
      body.backup_mailboxes,
      Number(curr.backup_mailboxes || 0)
    );
    const nextBackupCronjobs = toBitFlag(
      body.backup_cronjobs,
      Number(curr.backup_cronjobs || 0)
    );
    const nextBackupVhostConfigs = toBitFlag(
      body.backup_vhost_configs,
      Number(curr.backup_vhost_configs || 0)
    );
    const rawSshKeyPath = String(
      body.ssh_key_path !== undefined ? body.ssh_key_path : curr.ssh_key_path || ''
    ).trim();

    const invalidField = validateServerConnectionFields({
      hostname: nextHostname,
      ipAddress: nextIp,
      sshUser: nextSshUser,
      panelType: nextPanelType,
      sshPort: nextSshPort,
      bwLimitKbps: nextBwLimit,
    });
    if (invalidField) {
      return NextResponse.json({ error: invalidField }, { status: 400 });
    }

    let nextCustomExcludes = String(curr.custom_excludes || '');
    if (body.custom_excludes !== undefined) {
      const excludeCheck = validateExcludePatternsInput(
        String(body.custom_excludes ?? '')
      );
      if (!excludeCheck.ok) {
        return NextResponse.json(
          { error: excludeCheck.error || 'Quy tắc loại trừ không hợp lệ.' },
          { status: 400 }
        );
      }
      nextCustomExcludes = excludeCheck.normalized;
    }

    let nextSshKeyPath = '';
    if (rawSshKeyPath) {
      try {
        nextSshKeyPath = resolveValidatedSshKeyPath(rawSshKeyPath);
      } catch (err) {
        return NextResponse.json(
          { error: sanitizeErrorMessage(err, 'Đường dẫn khóa SSH không hợp lệ.') },
          { status: 400 }
        );
      }
      if (!fs.existsSync(nextSshKeyPath)) {
        return NextResponse.json(
          {
            error:
              'Không tìm thấy tệp khóa SSH được chỉ định trong thư mục SSH Keys.',
          },
          { status: 400 }
        );
      }
    }

    const endpointChanged =
      nextIp !== String(curr.ip_address) ||
      nextSshPort !== Number(curr.ssh_port);

    if (endpointChanged) {
      removeServerKnownHostsCache(serverId);
      const resetStatus = nextIsMock ? 'VERIFIED' : 'UNPINNED';
      const resetFp = nextIsMock ? MOCK_HOST_KEY_FINGERPRINT : '';

      db.prepare(
        `UPDATE servers
         SET hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, ssh_key_path = ?,
             panel_type = ?, assigned_volume_id = ?, bw_limit_kbps = ?, is_mock = ?, notes = ?,
             custom_excludes = ?,
             backup_mailboxes = ?, backup_cronjobs = ?, backup_vhost_configs = ?,
             host_key_status = ?, host_key_fingerprint = ?, known_host_entry = '',
             host_key_pending_fingerprint = '', host_key_pending_entry = ''
         WHERE id = ?`
      ).run(
        nextHostname,
        nextIp,
        nextSshPort,
        nextSshUser,
        nextSshKeyPath,
        nextPanelType,
        body.assigned_volume_id !== undefined
          ? body.assigned_volume_id
          : curr.assigned_volume_id,
        nextBwLimit,
        nextIsMock,
        body.notes !== undefined ? String(body.notes) : curr.notes,
        nextCustomExcludes,
        nextBackupMailboxes,
        nextBackupCronjobs,
        nextBackupVhostConfigs,
        resetStatus,
        resetFp,
        serverId
      );
    } else {
      db.prepare(
        `UPDATE servers
         SET hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, ssh_key_path = ?,
             panel_type = ?, assigned_volume_id = ?, bw_limit_kbps = ?, is_mock = ?, notes = ?,
             custom_excludes = ?,
             backup_mailboxes = ?, backup_cronjobs = ?, backup_vhost_configs = ?
         WHERE id = ?`
      ).run(
        nextHostname,
        nextIp,
        nextSshPort,
        nextSshUser,
        nextSshKeyPath,
        nextPanelType,
        body.assigned_volume_id !== undefined
          ? body.assigned_volume_id
          : curr.assigned_volume_id,
        nextBwLimit,
        nextIsMock,
        body.notes !== undefined ? String(body.notes) : curr.notes,
        nextCustomExcludes,
        nextBackupMailboxes,
        nextBackupCronjobs,
        nextBackupVhostConfigs,
        serverId
      );
    }

    recordAuditLog({
      session: guard.session,
      action: 'SERVER_UPDATE',
      resourceType: 'SERVER',
      resourceId: String(serverId),
      detail: `Cập nhật máy chủ VPS "${nextHostname}" (${nextIp}:${nextSshPort} - ${nextPanelType})${
        endpointChanged ? ' [Đặt lại TOFU Host Key do đổi IP/Port]' : ''
      }`,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể cập nhật thông tin máy chủ VPS.');
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const serverId = Number(id);
    const db = getDb();
    const curr = db
      .prepare('SELECT hostname, ip_address FROM servers WHERE id = ?')
      .get(serverId);

    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    removeServerKnownHostsCache(serverId);

    if (curr) {
      recordAuditLog({
        session: guard.session,
        action: 'SERVER_DELETE',
        resourceType: 'SERVER',
        resourceId: String(serverId),
        detail: `Xóa máy chủ VPS "${curr.hostname}" (${curr.ip_address})`,
        req,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể xóa máy chủ VPS.');
  }
}

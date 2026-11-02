import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { validateExcludePatternsInput } from '@/lib/engine/exclude-rules';
import { validateServerConnectionFields } from '@/lib/engine/safe-names';
import { resolveValidatedSshKeyPath } from '@/lib/ssh';

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
          { error: (err as Error).message },
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

    db.prepare(
      `UPDATE servers
       SET hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, ssh_key_path = ?,
           panel_type = ?, assigned_volume_id = ?, bw_limit_kbps = ?, is_mock = ?, notes = ?,
           custom_excludes = ?
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
      body.is_mock !== undefined ? (body.is_mock ? 1 : 0) : curr.is_mock,
      body.notes !== undefined ? String(body.notes) : curr.notes,
      nextCustomExcludes,
      serverId
    );

    recordAuditLog({
      session: guard.session,
      action: 'SERVER_UPDATE',
      resourceType: 'SERVER',
      resourceId: String(serverId),
      detail: `Cập nhật máy chủ VPS "${nextHostname}" (${nextIp}:${nextSshPort} - ${nextPanelType})`,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const serverId = Number(id);
  const db = getDb();
  const curr = db
    .prepare('SELECT hostname, ip_address FROM servers WHERE id = ?')
    .get(serverId);

  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);

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
}

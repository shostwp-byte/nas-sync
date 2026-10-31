import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { validateServerConnectionFields } from '@/lib/engine/safe-names';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const db = getDb();
    const curr = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(Number(id));

    if (!curr) {
      return NextResponse.json(
        { error: 'Không tìm thấy máy chủ VPS.' },
        { status: 404 }
      );
    }

    const invalidField = validateServerConnectionFields({
      hostname: String(body.hostname ?? curr.hostname).trim(),
      ipAddress: String(body.ip_address ?? curr.ip_address).trim(),
      sshUser: String(body.ssh_user ?? curr.ssh_user).trim(),
    });
    if (invalidField) {
      return NextResponse.json({ error: invalidField }, { status: 400 });
    }

    db.prepare(
      `UPDATE servers
       SET hostname = ?, ip_address = ?, ssh_port = ?, ssh_user = ?, ssh_key_path = ?,
           panel_type = ?, assigned_volume_id = ?, bw_limit_kbps = ?, is_mock = ?, notes = ?
       WHERE id = ?`
    ).run(
      body.hostname ?? curr.hostname,
      body.ip_address ?? curr.ip_address,
      Number(body.ssh_port ?? curr.ssh_port),
      body.ssh_user ?? curr.ssh_user,
      body.ssh_key_path ?? curr.ssh_key_path,
      body.panel_type ?? curr.panel_type,
      body.assigned_volume_id !== undefined
        ? body.assigned_volume_id
        : curr.assigned_volume_id,
      Number(body.bw_limit_kbps ?? curr.bw_limit_kbps),
      body.is_mock !== undefined ? (body.is_mock ? 1 : 0) : curr.is_mock,
      body.notes ?? curr.notes,
      Number(id)
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  getDb().prepare('DELETE FROM servers WHERE id = ?').run(Number(id));
  return NextResponse.json({ ok: true });
}


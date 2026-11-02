import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson, sanitizeErrorMessage } from '@/lib/api-error';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getPanelAdapter } from '@/lib/engine/adapters';
import { testSshConnection } from '@/lib/ssh';
import type { ServerRecord } from '@/types';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN', 'OPERATOR']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const db = getDb();
    const server = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(Number(id)) as unknown as ServerRecord | undefined;

    if (!server) {
      return NextResponse.json(
        { error: 'Không tìm thấy máy chủ.' },
        { status: 404 }
      );
    }

    const sshTest = await testSshConnection(server);
    const refreshedServer =
      (db
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get(server.id) as unknown as ServerRecord | undefined) || server;

    if (!sshTest.ok) {
      const nextStatus =
        refreshedServer.host_key_status === 'MISMATCH' ? 'ERROR' : 'OFFLINE';
      db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run(
        nextStatus,
        server.id
      );
      const cleanErr = sanitizeErrorMessage(
        sshTest.error,
        'Không thể kết nối SSH tới máy chủ VPS.'
      );
      return NextResponse.json(
        {
          ok: false,
          ssh: { ...sshTest, error: cleanErr },
          host_key_status: refreshedServer.host_key_status,
          host_key_fingerprint: refreshedServer.host_key_fingerprint,
          host_key_pending_fingerprint:
            refreshedServer.host_key_pending_fingerprint,
          error: cleanErr,
        },
        { status: 400 }
      );
    }

    const adapter = getPanelAdapter(refreshedServer);
    const domains = await adapter.discoverDomains(refreshedServer);

    db.prepare(
      `UPDATE servers SET status = 'ONLINE', last_connected_at = datetime('now') WHERE id = ?`
    ).run(server.id);

    return NextResponse.json({
      ok: true,
      ssh: sshTest,
      panelType: refreshedServer.panel_type,
      host_key_status: refreshedServer.host_key_status,
      host_key_fingerprint: refreshedServer.host_key_fingerprint,
      domains,
    });
  } catch (err) {
    return safeErrorJson(err, 'Kiểm tra kết nối SSH máy chủ thất bại.');
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getPanelAdapter } from '@/lib/engine/adapters';
import { testSshConnection } from '@/lib/ssh';
import type { ServerRecord } from '@/types';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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
    if (!sshTest.ok) {
      db.prepare(`UPDATE servers SET status = 'OFFLINE' WHERE id = ?`).run(
        server.id
      );
      return NextResponse.json(
        {
          ok: false,
          ssh: sshTest,
          error: sshTest.error,
        },
        { status: 400 }
      );
    }

    const adapter = getPanelAdapter(server);
    const domains = await adapter.discoverDomains(server);

    db.prepare(
      `UPDATE servers SET status = 'ONLINE', last_connected_at = datetime('now') WHERE id = ?`
    ).run(server.id);

    return NextResponse.json({
      ok: true,
      ssh: sshTest,
      panelType: server.panel_type,
      domains,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}


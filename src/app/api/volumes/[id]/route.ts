import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { refreshAllVolumes } from '@/lib/engine/volume-manager';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const db = getDb();

    const existing = db
      .prepare('SELECT * FROM storage_volumes WHERE id = ?')
      .get(Number(id));
    if (!existing) {
      return NextResponse.json(
        { error: 'Không tìm thấy phân vùng.' },
        { status: 404 }
      );
    }

    db.prepare(
      `UPDATE storage_volumes
       SET name = ?, max_usage_percent = ?, min_free_gb = ?, status = ?,
           priority = ?, btrfs_immutable_enabled = ?, btrfs_retention_days = ?
       WHERE id = ?`
    ).run(
      body.name ?? existing.name,
      Number(body.max_usage_percent ?? existing.max_usage_percent),
      Number(body.min_free_gb ?? existing.min_free_gb),
      body.status ?? existing.status,
      Number(body.priority ?? existing.priority),
      body.btrfs_immutable_enabled !== undefined
        ? body.btrfs_immutable_enabled
          ? 1
          : 0
        : existing.btrfs_immutable_enabled,
      Number(body.btrfs_retention_days ?? existing.btrfs_retention_days),
      Number(id)
    );

    const volumes = await refreshAllVolumes();
    return NextResponse.json({ ok: true, volumes });
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
  const db = getDb();
  db.prepare('DELETE FROM storage_volumes WHERE id = ?').run(Number(id));
  return NextResponse.json({ ok: true });
}


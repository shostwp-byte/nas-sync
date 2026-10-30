import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { refreshAllVolumes } from '@/lib/engine/volume-manager';

export async function GET(req: NextRequest) {
  const shouldRefresh = req.nextUrl.searchParams.get('refresh') !== '0';
  if (shouldRefresh) {
    const volumes = await refreshAllVolumes();
    return NextResponse.json({ volumes });
  }
  const volumes = getDb()
    .prepare('SELECT * FROM storage_volumes ORDER BY priority ASC, id ASC')
    .all();
  return NextResponse.json({ volumes });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name || '').trim();
    const mountPath = String(body.mount_path || '').trim();
    const maxUsage = Number(body.max_usage_percent ?? 85);
    const minFreeGb = Number(body.min_free_gb ?? 200);
    const priority = Number(body.priority ?? 1);
    const btrfsEnabled = body.btrfs_immutable_enabled ? 1 : 0;
    const btrfsDays = Number(body.btrfs_retention_days ?? 7);

    if (!name || !mountPath) {
      return NextResponse.json(
        { error: 'Tên phân vùng và đường dẫn Mount Path là bắt buộc.' },
        { status: 400 }
      );
    }

    try {
      if (!fs.existsSync(mountPath)) {
        fs.mkdirSync(mountPath, { recursive: true });
      }
    } catch {
      // Bỏ qua nếu mount point chưa gắn
    }

    const db = getDb();
    db.prepare(
      `INSERT INTO storage_volumes
       (name, mount_path, max_usage_percent, min_free_gb, status, priority, btrfs_immutable_enabled, btrfs_retention_days)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?)`
    ).run(
      name,
      mountPath,
      maxUsage,
      minFreeGb,
      priority,
      btrfsEnabled,
      btrfsDays
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


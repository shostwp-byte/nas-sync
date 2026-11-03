import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { refreshAllVolumes } from '@/lib/engine/volume-manager';

const VALID_VOLUME_STATUSES = new Set(['ACTIVE', 'FULL', 'MAINTENANCE']);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

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

    const nextName =
      body.name !== undefined
        ? String(body.name).trim()
        : String(existing.name);
    if (!nextName || nextName.length > 128) {
      return NextResponse.json(
        { error: 'Tên phân vùng không hợp lệ (1-128 ký tự).' },
        { status: 400 }
      );
    }

    const nextMaxUsage = Number(
      body.max_usage_percent ?? existing.max_usage_percent
    );
    if (!Number.isFinite(nextMaxUsage) || nextMaxUsage < 10 || nextMaxUsage > 99) {
      return NextResponse.json(
        { error: 'Ngưỡng sử dụng tối đa (max_usage_percent) phải nằm trong khoảng 10% - 99%.' },
        { status: 400 }
      );
    }

    const nextMinFreeGb = Number(body.min_free_gb ?? existing.min_free_gb);
    if (!Number.isFinite(nextMinFreeGb) || nextMinFreeGb < 0 || nextMinFreeGb > 1_000_000) {
      return NextResponse.json(
        { error: 'Dung lượng trống tối thiểu (min_free_gb) phải từ 0 GB trở lên.' },
        { status: 400 }
      );
    }

    const nextStatus = String(body.status ?? existing.status);
    if (!VALID_VOLUME_STATUSES.has(nextStatus)) {
      return NextResponse.json(
        { error: 'Trạng thái phân vùng không hợp lệ.' },
        { status: 400 }
      );
    }

    const nextPriority = Number(body.priority ?? existing.priority);
    if (!Number.isInteger(nextPriority) || nextPriority < 1 || nextPriority > 999) {
      return NextResponse.json(
        { error: 'Độ ưu tiên (priority) phải là số nguyên từ 1 đến 999.' },
        { status: 400 }
      );
    }

    const nextBtrfsDays = Number(
      body.btrfs_retention_days ?? existing.btrfs_retention_days
    );
    if (!Number.isInteger(nextBtrfsDays) || nextBtrfsDays < 1 || nextBtrfsDays > 3650) {
      return NextResponse.json(
        { error: 'Số ngày khóa WORM Snapshot phải là số nguyên từ 1 đến 3650.' },
        { status: 400 }
      );
    }

    db.prepare(
      `UPDATE storage_volumes
       SET name = ?, max_usage_percent = ?, min_free_gb = ?, status = ?,
           priority = ?, btrfs_immutable_enabled = ?, btrfs_retention_days = ?
       WHERE id = ?`
    ).run(
      nextName,
      nextMaxUsage,
      nextMinFreeGb,
      nextStatus,
      nextPriority,
      body.btrfs_immutable_enabled !== undefined
        ? body.btrfs_immutable_enabled
          ? 1
          : 0
        : existing.btrfs_immutable_enabled,
      nextBtrfsDays,
      Number(id)
    );

    const volumes = await refreshAllVolumes();
    return NextResponse.json({ ok: true, volumes });
  } catch (err) {
    return safeErrorJson(err, 'Không thể cập nhật phân vùng lưu trữ.', 500);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const db = getDb();
    db.prepare('DELETE FROM storage_volumes WHERE id = ?').run(Number(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể xóa phân vùng lưu trữ.', 500);
  }
}


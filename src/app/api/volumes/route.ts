import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getDataDir, getDb, getSshKeysDir } from '@/lib/db';
import { refreshAllVolumes } from '@/lib/engine/volume-manager';

const FORBIDDEN_POSIX_PREFIXES = [
  '/app',
  '/root',
  '/etc',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/proc',
  '/sys',
  '/dev',
  '/tmp',
  '/run',
  '/boot',
];

function isSameOrSubpath(parentDir: string, candidate: string): boolean {
  const normParent = path.resolve(parentDir);
  const normCandidate = path.resolve(candidate);
  return (
    normCandidate === normParent ||
    normCandidate.startsWith(normParent + path.sep)
  );
}

function validateAndNormalizeMountPath(rawMountPath: string): {
  ok: boolean;
  normalized?: string;
  error?: string;
} {
  const trimmed = rawMountPath.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.length > 512) {
    return { ok: false, error: 'Đường dẫn Mount Path không hợp lệ.' };
  }

  const segments = trimmed.split(/[/\\]+/);
  if (segments.includes('..')) {
    return {
      ok: false,
      error: 'Đường dẫn Mount Path không được chứa tham chiếu "..".',
    };
  }

  if (process.platform !== 'win32') {
    if (!trimmed.startsWith('/')) {
      return {
        ok: false,
        error: 'Đường dẫn Mount Path phải là đường dẫn tuyệt đối bắt đầu bằng "/".',
      };
    }

    const normalized = path.posix.normalize(trimmed).replace(/\/+$/, '') || '/';
    if (normalized === '/') {
      return {
        ok: false,
        error: 'Không được phép gắn trực tiếp thư mục gốc "/" làm phân vùng sao lưu.',
      };
    }

    for (const forbidden of FORBIDDEN_POSIX_PREFIXES) {
      if (normalized === forbidden || normalized.startsWith(`${forbidden}/`)) {
        return {
          ok: false,
          error: `Đường dẫn hệ thống "${forbidden}" bị khóa bảo vệ, vui lòng chọn thư mục Mount riêng (ví dụ: /mnt/vol1, /volume1/...).`,
        };
      }
    }

    if (
      isSameOrSubpath(getDataDir(), normalized) ||
      isSameOrSubpath(getSshKeysDir(), normalized)
    ) {
      return {
        ok: false,
        error:
          'Không được phép đặt Mount Path trùng hoặc nằm trong thư mục dữ liệu nội bộ / khóa SSH của ứng dụng.',
      };
    }

    return { ok: true, normalized };
  }

  // Môi trường Windows Local Dev
  if (!path.isAbsolute(trimmed)) {
    return {
      ok: false,
      error: 'Đường dẫn Mount Path phải là đường dẫn tuyệt đối.',
    };
  }
  const resolved = path.resolve(trimmed);
  if (path.parse(resolved).root === resolved) {
    return {
      ok: false,
      error: 'Không được phép chọn trực tiếp thư mục gốc ổ đĩa làm phân vùng sao lưu.',
    };
  }
  if (
    isSameOrSubpath(getDataDir(), resolved) ||
    isSameOrSubpath(getSshKeysDir(), resolved)
  ) {
    return {
      ok: false,
      error:
        'Không được phép đặt Mount Path trùng hoặc nằm trong thư mục dữ liệu nội bộ / khóa SSH của ứng dụng.',
    };
  }

  return { ok: true, normalized: resolved };
}

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
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const name = String(body.name || '').trim();
    const rawMountPath = String(body.mount_path || '').trim();
    const maxUsage = Number(body.max_usage_percent ?? 85);
    const minFreeGb = Number(body.min_free_gb ?? 10);
    const priority = Number(body.priority ?? 1);
    const btrfsEnabled = body.btrfs_immutable_enabled ? 1 : 0;
    const btrfsDays = Number(body.btrfs_retention_days ?? 7);

    if (!name || name.length > 128 || !rawMountPath) {
      return NextResponse.json(
        { error: 'Tên phân vùng (tối đa 128 ký tự) và đường dẫn Mount Path là bắt buộc.' },
        { status: 400 }
      );
    }

    const mountCheck = validateAndNormalizeMountPath(rawMountPath);
    if (!mountCheck.ok || !mountCheck.normalized) {
      return NextResponse.json(
        { error: mountCheck.error || 'Đường dẫn Mount Path không hợp lệ.' },
        { status: 400 }
      );
    }
    const mountPath = mountCheck.normalized;

    if (!Number.isFinite(maxUsage) || maxUsage < 10 || maxUsage > 99) {
      return NextResponse.json(
        { error: 'Ngưỡng sử dụng tối đa (max_usage_percent) phải nằm trong khoảng 10% - 99%.' },
        { status: 400 }
      );
    }

    if (!Number.isFinite(minFreeGb) || minFreeGb < 0 || minFreeGb > 1_000_000) {
      return NextResponse.json(
        { error: 'Dung lượng trống tối thiểu (min_free_gb) phải từ 0 GB trở lên.' },
        { status: 400 }
      );
    }

    if (!Number.isInteger(priority) || priority < 1 || priority > 999) {
      return NextResponse.json(
        { error: 'Độ ưu tiên (priority) phải là số nguyên từ 1 đến 999.' },
        { status: 400 }
      );
    }

    if (!Number.isInteger(btrfsDays) || btrfsDays < 1 || btrfsDays > 3650) {
      return NextResponse.json(
        { error: 'Số ngày khóa Btrfs WORM phải là số nguyên từ 1 đến 3650.' },
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


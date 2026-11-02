import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import {
  resolveSafeSnapshotRoot,
  resolveSafeSubPath,
} from '@/lib/engine/explorer';

export async function GET(req: NextRequest) {
  try {
    const guard = await requireRole(
      ['ADMIN', 'OPERATOR'],
      'Tài khoản VIEWER không có quyền tải xuống dữ liệu sao lưu.'
    );
    if (!guard.ok) return guard.response;

    const sp = req.nextUrl.searchParams;
    const jobId = Number(sp.get('jobId'));
    const relPath = sp.get('path') || '';

    if (!jobId || !relPath) {
      return NextResponse.json(
        { error: 'Thiếu tham số jobId hoặc path.' },
        { status: 400 }
      );
    }

    const { snapshotRoot, hostname, snapshotName } =
      resolveSafeSnapshotRoot(jobId);
    const fullPath = resolveSafeSubPath(snapshotRoot, relPath);

    if (!fs.existsSync(fullPath)) {
      return NextResponse.json(
        { error: 'File không tồn tại.' },
        { status: 404 }
      );
    }

    const stat = fs.lstatSync(fullPath);
    if (!stat.isFile()) {
      return NextResponse.json(
        {
          error:
            'Chỉ hỗ trợ tải xuống tập tin thông thường (từ chối thư mục, symlink hoặc thiết bị đặc biệt).',
        },
        { status: 400 }
      );
    }

    const { size } = stat;
    const fileName = path.basename(fullPath);

    recordAuditLog({
      session: guard.session,
      action: 'DOWNLOAD_FILE',
      resourceType: 'SNAPSHOT',
      resourceId: String(jobId),
      detail: `Tải tập tin "${relPath}" từ ${hostname}@${snapshotName}`,
      req,
    });

    // Stream thay vì readFileSync: file backup (SQL dump, archive) có thể nhiều GB — đọc
    // toàn bộ vào RAM sẽ làm sập tiến trình Node trên NAS (Buffer tối đa ~2-4 GB).
    const body = Readable.toWeb(
      fs.createReadStream(fullPath)
    ) as ReadableStream<Uint8Array>;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
          fileName
        )}`,
        'Content-Length': String(size),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}

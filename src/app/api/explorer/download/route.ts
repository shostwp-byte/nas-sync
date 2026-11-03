import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import {
  resolveSafeSnapshotRoot,
  resolveSafeSubPath,
} from '@/lib/engine/explorer';
import { acquireSnapshotReadPin } from '@/lib/engine/snapshot-pins';

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

    const { serverId, snapshotRoot, hostname, snapshotName } =
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

    const releasePin = acquireSnapshotReadPin(serverId, snapshotName);
    let pinReleased = false;
    const releasePinOnce = () => {
      if (pinReleased) return;
      pinReleased = true;
      releasePin();
    };

    const fileStream = fs.createReadStream(fullPath, {
      highWaterMark: 256 * 1024,
    });
    fileStream.once('close', releasePinOnce);
    fileStream.once('error', releasePinOnce);
    req.signal.addEventListener(
      'abort',
      () => {
        fileStream.destroy();
        releasePinOnce();
      },
      { once: true }
    );

    const body = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
          fileName
        )}`,
        'Content-Length': String(size),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể tải xuống tập tin sao lưu.',
      400
    );
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest, NextResponse } from 'next/server';
import {
  resolveSafeSnapshotRoot,
  resolveSafeSubPath,
} from '@/lib/engine/explorer';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const jobId = Number(sp.get('jobId'));
    const relPath = sp.get('path') || '';

    if (!jobId || !relPath) {
      return NextResponse.json(
        { error: 'Thiếu tham số jobId hoặc path.' },
        { status: 400 }
      );
    }

    const { snapshotRoot } = resolveSafeSnapshotRoot(jobId);
    const fullPath = resolveSafeSubPath(snapshotRoot, relPath);

    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return NextResponse.json(
        { error: 'File không tồn tại.' },
        { status: 404 }
      );
    }

    const { size } = fs.statSync(fullPath);
    const fileName = path.basename(fullPath);
    // Stream thay vì readFileSync: file backup (SQL dump, archive) có thể nhiều GB — đọc
    // toàn bộ vào RAM sẽ làm sập tiến trình Node trên NAS (Buffer tối đa ~2-4 GB).
    const body = Readable.toWeb(fs.createReadStream(fullPath)) as ReadableStream<Uint8Array>;

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

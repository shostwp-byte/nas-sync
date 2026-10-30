import fs from 'node:fs';
import path from 'node:path';
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

    const fileBuf = fs.readFileSync(fullPath);
    const fileName = path.basename(fullPath);

    return new NextResponse(fileBuf, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(
          fileName
        )}"`,
        'Content-Length': String(fileBuf.length),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}


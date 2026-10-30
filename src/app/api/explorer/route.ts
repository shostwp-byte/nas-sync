import { NextRequest, NextResponse } from 'next/server';
import {
  listSnapshotDirectory,
  readSnapshotFilePreview,
} from '@/lib/engine/explorer';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const jobId = Number(sp.get('jobId'));
    const relPath = sp.get('path') || '';
    const isPreview = sp.get('preview') === '1';

    if (!jobId) {
      return NextResponse.json(
        { error: 'Thiếu tham số jobId.' },
        { status: 400 }
      );
    }

    if (isPreview) {
      const preview = readSnapshotFilePreview(jobId, relPath);
      return NextResponse.json({ ok: true, preview });
    }

    const listing = listSnapshotDirectory(jobId, relPath);
    return NextResponse.json({ ok: true, ...listing });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}


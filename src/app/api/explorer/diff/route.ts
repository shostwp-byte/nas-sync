import { NextRequest, NextResponse } from 'next/server';
import { compareSnapshotFilesDiff } from '@/lib/engine/explorer';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const baseJobId = Number(sp.get('baseJobId'));
    const targetJobId = Number(sp.get('targetJobId'));
    const relPath = sp.get('path') || '';

    if (!baseJobId || !targetJobId || !relPath) {
      return NextResponse.json(
        { error: 'Vui lòng chọn đủ 2 bản Snapshot và đường dẫn file để so sánh Diff.' },
        { status: 400 }
      );
    }

    const diff = compareSnapshotFilesDiff(baseJobId, targetJobId, relPath);
    return NextResponse.json({ ok: true, diff });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}


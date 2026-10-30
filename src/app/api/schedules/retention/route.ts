import { NextRequest, NextResponse } from 'next/server';
import { applyGfsRetentionForServer } from '@/lib/engine/retention-gfs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const serverId = Number(body.serverId);
    const dryRun = Boolean(body.dryRun);
    const policy = body.policy || { daily: 7, weekly: 4, monthly: 6 };

    if (!serverId) {
      return NextResponse.json(
        { error: 'Vui lòng chọn máy chủ để kiểm tra/chạy chính sách GFS.' },
        { status: 400 }
      );
    }

    const result = await applyGfsRetentionForServer(serverId, policy, dryRun);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


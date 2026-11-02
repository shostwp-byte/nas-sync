import { NextRequest, NextResponse } from 'next/server';
import { acquireServerLock } from '@/lib/engine/queue';
import { applyGfsRetentionForServer } from '@/lib/engine/retention-gfs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const serverId = Number(body.serverId);
    const dryRun = Boolean(body.dryRun);
    const rawPolicy = body.policy || { daily: 7, weekly: 4, monthly: 6 };

    if (!Number.isInteger(serverId) || serverId <= 0) {
      return NextResponse.json(
        { error: 'Vui lòng chọn máy chủ để kiểm tra/chạy chính sách GFS.' },
        { status: 400 }
      );
    }

    const daily = Number(rawPolicy.daily ?? 7);
    const weekly = Number(rawPolicy.weekly ?? 4);
    const monthly = Number(rawPolicy.monthly ?? 6);
    if (
      !Number.isInteger(daily) ||
      daily < 1 ||
      daily > 3650 ||
      !Number.isInteger(weekly) ||
      weekly < 0 ||
      weekly > 520 ||
      !Number.isInteger(monthly) ||
      monthly < 0 ||
      monthly > 240
    ) {
      return NextResponse.json(
        {
          error:
            'Chính sách lưu trữ GFS không hợp lệ (Daily >= 1, Weekly >= 0, Monthly >= 0).',
        },
        { status: 400 }
      );
    }

    const policy = { daily, weekly, monthly };

    if (dryRun) {
      const result = await applyGfsRetentionForServer(serverId, policy, true);
      return NextResponse.json({ ok: true, ...result });
    }

    const release = await acquireServerLock(serverId);
    try {
      const result = await applyGfsRetentionForServer(serverId, policy, false);
      return NextResponse.json({ ok: true, ...result });
    } finally {
      release();
    }
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


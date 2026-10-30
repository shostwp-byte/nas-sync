import { NextRequest, NextResponse } from 'next/server';
import { triggerSynologyBtrfsImmutableSnapshot } from '@/lib/engine/btrfs-worm';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const days = Number(body.retentionDays || 7);
  const result = await triggerSynologyBtrfsImmutableSnapshot(days);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}


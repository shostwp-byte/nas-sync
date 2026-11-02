import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { triggerSynologyBtrfsImmutableSnapshot } from '@/lib/engine/btrfs-worm';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const days = Number(body.retentionDays || 7);
  const result = await triggerSynologyBtrfsImmutableSnapshot(days);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

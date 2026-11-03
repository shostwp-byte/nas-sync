import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { triggerImmutableWormSnapshot } from '@/lib/engine/worm-snapshot';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const days = body.retentionDays !== undefined ? Number(body.retentionDays) : undefined;
  const result = await triggerImmutableWormSnapshot(days);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

import { NextResponse } from 'next/server';
import { getQueueRuntimeInfo } from '@/lib/engine/queue';

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'NAS-Sync',
    timestamp: new Date().toISOString(),
    queue: getQueueRuntimeInfo(),
  });
}


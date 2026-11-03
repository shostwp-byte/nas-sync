import { NextRequest } from 'next/server';
import { POST as triggerSnapshotPost } from '@/app/api/volumes/snapshot/route';

export async function POST(req: NextRequest) {
  return triggerSnapshotPost(req);
}

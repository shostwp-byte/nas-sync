import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { triggerImmutableWormSnapshot } from '@/lib/engine/worm-snapshot';

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json().catch(() => ({}));
    const days =
      body.retentionDays !== undefined ? Number(body.retentionDays) : undefined;
    const result = await triggerImmutableWormSnapshot(days);

    recordAuditLog({
      session: guard.session,
      action: 'WORM_SNAPSHOT_TRIGGER',
      resourceType: 'VOLUME',
      detail: `Kích hoạt thủ công OS-Level WORM Snapshot (${result.provider}) — Kết quả: ${
        result.ok ? 'Thành công' : 'Thất bại'
      }`,
      req,
    });

    return NextResponse.json(result, { status: result.ok ? 200 : 500 });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể thực thi yêu cầu khóa bất biến WORM Snapshot.',
      500
    );
  }
}

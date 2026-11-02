import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { sendDailyMorningDigest } from '@/lib/engine/morning-digest';

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { summary, dispatch } = await sendDailyMorningDigest({
      manual: true,
    });

    recordAuditLog({
      session: guard.session,
      action: 'SEND_MORNING_DIGEST',
      resourceType: 'SETTINGS',
      detail: `Gửi thủ công Báo cáo NOC Buổi sáng (24h: ${summary.jobsSucceeded24h} thành công / ${summary.jobsFailed24h} lỗi | Telegram: ${
        dispatch.telegramSent ? 'OK' : 'SKIP/ERR'
      }, Email: ${dispatch.emailSent ? 'OK' : 'SKIP/ERR'})`,
      req,
    });

    return NextResponse.json({
      ok: true,
      summary,
      dispatch,
    });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể gửi Báo cáo NOC Buổi sáng ngay lúc này.'
    );
  }
}

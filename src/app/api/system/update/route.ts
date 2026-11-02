import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import {
  checkGitHubUpdate,
  getActiveBlockingReason,
  getRollbackMetadata,
  performGitHubUpdate,
  performRollbackRelease,
} from '@/lib/updater';

export async function GET() {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const info = await checkGitHubUpdate();
    return NextResponse.json(info);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || 'update').trim();
    const force = Boolean(body?.force);

    const { canUpdateNow, blockingReason } = getActiveBlockingReason();
    if (!canUpdateNow) {
      return NextResponse.json(
        { error: blockingReason || 'Không thể thực hiện thao tác ngay lúc này.' },
        { status: 409 }
      );
    }

    if (action === 'rollback') {
      const rollbackMeta = getRollbackMetadata();
      if (!rollbackMeta.canRollback || !rollbackMeta.rollbackVersion) {
        return NextResponse.json(
          {
            error:
              'Không tìm thấy bản lưu phiên bản trước hợp lệ để thực hiện Rollback.',
          },
          { status: 400 }
        );
      }

      recordAuditLog({
        session: guard.session,
        action: 'SYSTEM_ROLLBACK',
        resourceType: 'SYSTEM',
        resourceId: rollbackMeta.rollbackVersion,
        detail: `Kích hoạt 1-Click Rollback hệ thống về phiên bản v${rollbackMeta.rollbackVersion}`,
        req,
      });

      void performRollbackRelease().catch((err) => {
        console.error('[NAS-Sync Rollback Error]:', err);
      });

      return NextResponse.json({
        ok: true,
        message: `Đã bắt đầu khôi phục (Rollback) về phiên bản v${rollbackMeta.rollbackVersion}. Theo dõi trực tiếp trên màn hình...`,
      });
    }

    recordAuditLog({
      session: guard.session,
      action: 'SYSTEM_UPDATE',
      resourceType: 'SYSTEM',
      detail: `Kích hoạt cập nhật hệ thống từ GitHub${
        force ? ' (chế độ Force biên dịch lại từ mã nguồn)' : ''
      }`,
      req,
    });

    // Chạy bất đồng bộ và đẩy tiến trình qua Socket.IO (system:update_progress)
    void performGitHubUpdate({ force }).catch((err) => {
      console.error('[NAS-Sync Updater Error]:', err);
    });

    return NextResponse.json({
      ok: true,
      message:
        'Đã bắt đầu tiến trình cập nhật từ GitHub. Theo dõi trực tiếp trên màn hình...',
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}

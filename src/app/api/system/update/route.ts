import { NextRequest, NextResponse } from 'next/server';
import { checkGitHubUpdate, performGitHubUpdate } from '@/lib/updater';

export async function GET() {
  try {
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
    const body = await req.json().catch(() => ({}));
    const force = Boolean(body?.force);

    // Chạy bất đồng bộ và đẩy tiến trình qua Socket.IO (system:update_progress)
    void performGitHubUpdate({ force }).catch((err) => {
      console.error('[NAS-Sync Updater Error]:', err);
    });

    return NextResponse.json({
      ok: true,
      message: 'Đã bắt đầu tiến trình cập nhật từ GitHub. Theo dõi trực tiếp trên màn hình...',
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}


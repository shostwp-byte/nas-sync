import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, getDb, setSettings } from '@/lib/db';
import { reloadCronSchedules } from '@/lib/engine/queue';
import { dispatchExternalNotifications } from '@/lib/notifications';

export async function GET() {
  const settings = getAllSettings();
  const alerts = getDb()
    .prepare('SELECT * FROM system_alerts ORDER BY id DESC LIMIT 50')
    .all();

  return NextResponse.json({ settings, alerts });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.settings && typeof body.settings === 'object') {
      const sanitized: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.settings)) {
        sanitized[k] = String(v ?? '');
      }
      setSettings(sanitized);
      reloadCronSchedules();
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || '');

    if (action === 'mark_all_read') {
      getDb().prepare('UPDATE system_alerts SET is_read = 1 WHERE is_read = 0').run();
      return NextResponse.json({ ok: true });
    }

    if (action === 'test_notification') {
      const res = await dispatchExternalNotifications({
        severity: 'INFO',
        category: 'SYSTEM',
        title: 'Kiểm tra kết nối cảnh báo SHOST Backup Platform',
        message:
          'Đây là tin nhắn kiểm tra từ hệ thống Sao lưu Tập trung SHOST Backup chạy trên Synology NAS.',
      });
      return NextResponse.json({ ok: true, ...res });
    }

    return NextResponse.json(
      { error: 'Hành động không hợp lệ.' },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


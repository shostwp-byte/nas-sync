import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, getDb, getSetting, setSettings } from '@/lib/db';
import { reloadCronSchedules } from '@/lib/engine/queue';
import {
  detectTelegramChatId,
  dispatchExternalNotifications,
} from '@/lib/notifications';

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

    if (action === 'detect_telegram_chat_id') {
      const token = String(
        body.botToken || getSetting('telegram_bot_token') || ''
      );
      const detected = await detectTelegramChatId(token);
      if (!detected.ok) {
        return NextResponse.json(detected, { status: 400 });
      }
      if (detected.chatId) {
        setSettings({
          telegram_bot_token: token.trim().replace(/^bot/i, ''),
          telegram_chat_id: detected.chatId,
        });
      }
      return NextResponse.json(detected);
    }

    if (action === 'test_notification') {
      const res = await dispatchExternalNotifications({
        severity: 'INFO',
        category: 'SYSTEM',
        title: 'Kiểm tra kết nối cảnh báo NAS-Sync',
        message:
          'Đây là tin nhắn kiểm tra thành công từ hệ thống Sao lưu Tập trung NAS-Sync đang chạy trên Synology NAS của bạn.',
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

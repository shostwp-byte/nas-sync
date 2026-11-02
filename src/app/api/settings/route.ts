import { NextRequest, NextResponse } from 'next/server';
import { getAllSettings, getDb, getSetting, setSettings } from '@/lib/db';
import { reloadCronSchedules } from '@/lib/engine/queue';
import {
  detectTelegramChatId,
  dispatchExternalNotifications,
} from '@/lib/notifications';

const SECRET_MASK = '••••••••';

const SECRET_SETTING_KEYS = new Set([
  'smtp_pass',
  'dsm_password',
  'telegram_bot_token',
  'github_token',
]);

const ALLOWED_SETTING_KEYS = new Set([
  'telegram_bot_token',
  'telegram_chat_id',
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
  'alert_email_to',
  'notify_email_to',
  'anomaly_max_changed_percent',
  'anomaly_max_delta_gb',
  'anomaly_change_ratio_percent',
  'anomaly_size_spike_gb',
  'dsm_api_url',
  'dsm_username',
  'dsm_password',
  'dsm_backup_shares',
  'dsm_btrfs_shares',
  'btrfs_cron_time',
  'btrfs_auto_enabled',
  'dsm_worm_Enabled',
  'dsm_worm_enabled',
  'dsm_worm_lock_days',
  'github_token',
]);

export async function GET() {
  const rawSettings = getAllSettings();
  const settings: Record<string, string> = { ...rawSettings };
  for (const key of SECRET_SETTING_KEYS) {
    if (settings[key]) {
      settings[key] = SECRET_MASK;
    }
  }

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
        if (!ALLOWED_SETTING_KEYS.has(k)) {
          continue;
        }
        const strVal = String(v ?? '');
        if (SECRET_SETTING_KEYS.has(k) && strVal === SECRET_MASK) {
          continue;
        }
        sanitized[k] = strVal;
      }
      if (Object.keys(sanitized).length > 0) {
        setSettings(sanitized);
      }
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
      const rawInputToken = String(body.botToken || '').trim();
      const effectiveToken =
        !rawInputToken || rawInputToken === SECRET_MASK
          ? getSetting('telegram_bot_token')
          : rawInputToken;

      const detected = await detectTelegramChatId(effectiveToken);
      if (!detected.ok) {
        return NextResponse.json(detected, { status: 400 });
      }
      if (detected.chatId) {
        const updates: Record<string, string> = {
          telegram_chat_id: detected.chatId,
        };
        if (rawInputToken && rawInputToken !== SECRET_MASK) {
          updates.telegram_bot_token = rawInputToken.replace(/^bot/i, '');
        }
        setSettings(updates);
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

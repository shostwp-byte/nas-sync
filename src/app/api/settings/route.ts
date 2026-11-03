import cron from 'node-cron';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole, type SessionPayload } from '@/lib/auth';
import { getAllSettings, getDb, getSetting, setSettings } from '@/lib/db';
import {
  DEFAULT_WORDPRESS_HOSTING_EXCLUDES,
  validateExcludePatternsInput,
} from '@/lib/engine/exclude-rules';
import { sendDailyMorningDigest } from '@/lib/engine/morning-digest';
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
  'offsite_encryption_passphrase',
  'offsite_s3_secret_key',
  'offsite_gdrive_client_secret',
  'offsite_gdrive_refresh_token',
  'offsite_gdrive_service_account_json',
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
  'dsm_worm_enabled',
  'dsm_worm_lock_days',
  'dsm_tls_insecure',
  'github_token',
  'global_exclude_patterns',
  'digest_enabled',
  'digest_cron_time',
  'offsite_provider',
  'offsite_auto_push',
  'offsite_keep_count',
  'offsite_encryption_passphrase',
  'offsite_s3_preset',
  'offsite_s3_endpoint',
  'offsite_s3_region',
  'offsite_s3_bucket',
  'offsite_s3_prefix',
  'offsite_s3_access_key',
  'offsite_s3_secret_key',
  'offsite_gdrive_auth_mode',
  'offsite_gdrive_folder_id',
  'offsite_gdrive_client_id',
  'offsite_gdrive_client_secret',
  'offsite_gdrive_refresh_token',
  'offsite_gdrive_service_account_json',
]);

const CRON_TRIGGER_KEYS = new Set([
  'digest_enabled',
  'digest_cron_time',
  'btrfs_auto_enabled',
  'btrfs_cron_time',
]);

function applySettingsDictionary(
  rawDict: Record<string, unknown>,
  session: SessionPayload,
  req: NextRequest
): NextResponse | null {
  const sanitized: Record<string, string> = {};

  for (const [k, v] of Object.entries(rawDict)) {
    if (!ALLOWED_SETTING_KEYS.has(k)) {
      continue;
    }
    const strVal = String(v ?? '');
    if (SECRET_SETTING_KEYS.has(k) && strVal === SECRET_MASK) {
      continue;
    }
    if (k === 'global_exclude_patterns') {
      const check = validateExcludePatternsInput(strVal);
      if (!check.ok) {
        return NextResponse.json(
          { error: check.error || 'Quy tắc loại trừ không hợp lệ.' },
          { status: 400 }
        );
      }
      sanitized[k] = check.normalized;
      continue;
    }
    if ((k === 'digest_cron_time' || k === 'btrfs_cron_time') && strVal.trim()) {
      if (!cron.validate(strVal.trim())) {
        return NextResponse.json(
          {
            error: `Biểu thức lịch Cron (${k}) không hợp lệ: "${strVal.trim()}".`,
          },
          { status: 400 }
        );
      }
      sanitized[k] = strVal.trim();
      continue;
    }
    if (k === 'offsite_provider') {
      const upper = strVal.trim().toUpperCase();
      if (!['NONE', 'S3_COMPATIBLE', 'GOOGLE_DRIVE'].includes(upper)) {
        return NextResponse.json(
          { error: 'Nhà cung cấp Offsite Cloud không hợp lệ.' },
          { status: 400 }
        );
      }
      sanitized[k] = upper;
      continue;
    }
    if (k === 'offsite_auto_push') {
      const upper = strVal.trim().toUpperCase();
      if (!['NONE', 'WEEKLY_SUNDAY', 'EVERY_BACKUP'].includes(upper)) {
        return NextResponse.json(
          { error: 'Chế độ tự động đồng bộ Offsite không hợp lệ.' },
          { status: 400 }
        );
      }
      sanitized[k] = upper;
      continue;
    }
    if (k === 'offsite_keep_count') {
      const num = parseInt(strVal.trim(), 10);
      sanitized[k] = String(
        Number.isFinite(num) && num >= 1 ? Math.min(num, 3650) : 12
      );
      continue;
    }
    sanitized[k] = strVal;
  }

  const updatedKeys = Object.keys(sanitized);
  if (updatedKeys.length > 0) {
    setSettings(sanitized);
    recordAuditLog({
      session,
      action: 'SETTINGS_UPDATE',
      resourceType: 'SETTINGS',
      detail: `Cập nhật cấu hình hệ thống (${updatedKeys.join(', ')})`,
      req,
    });
    if (updatedKeys.some((k) => CRON_TRIGGER_KEYS.has(k))) {
      reloadCronSchedules();
    }
  }

  return null;
}

export async function GET() {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

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

    return NextResponse.json({
      settings,
      alerts,
      defaultExcludePreset: DEFAULT_WORDPRESS_HOSTING_EXCLUDES,
    });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tải cấu hình hệ thống.');
  }
}

export async function PUT(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    if (body.settings && typeof body.settings === 'object') {
      const errResp = applySettingsDictionary(
        body.settings as Record<string, unknown>,
        guard.session,
        req
      );
      if (errResp) return errResp;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return safeErrorJson(err, 'Không thể lưu cấu hình hệ thống.');
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const action = String(body.action || '').trim();

    if (
      (!action || action === 'save_settings') &&
      ((body.settings && typeof body.settings === 'object') ||
        Object.keys(body).some((k) => ALLOWED_SETTING_KEYS.has(k)))
    ) {
      const dict =
        body.settings && typeof body.settings === 'object'
          ? (body.settings as Record<string, unknown>)
          : (body as Record<string, unknown>);
      const errResp = applySettingsDictionary(dict, guard.session, req);
      if (errResp) return errResp;
      return NextResponse.json({ ok: true });
    }

    if (action === 'mark_all_read') {
      getDb()
        .prepare('UPDATE system_alerts SET is_read = 1 WHERE is_read = 0')
        .run();
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

    if (action === 'send_digest_now') {
      const { summary, dispatch } = await sendDailyMorningDigest({
        manual: true,
      });
      recordAuditLog({
        session: guard.session,
        action: 'SEND_MORNING_DIGEST',
        resourceType: 'SETTINGS',
        detail: `Gửi thủ công Báo cáo NOC Buổi sáng (${summary.jobsSucceeded24h} OK / ${summary.jobsFailed24h} lỗi)`,
        req,
      });
      return NextResponse.json({ ok: true, summary, dispatch });
    }

    return NextResponse.json(
      { error: 'Hành động không hợp lệ.' },
      { status: 400 }
    );
  } catch (err) {
    return safeErrorJson(err, 'Không thể thực hiện thao tác cấu hình.');
  }
}

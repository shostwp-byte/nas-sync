import nodemailer from 'nodemailer';
import { getDb, getSetting } from './db';
import { emitNewAlert } from './events';
import type { SystemAlert } from '@/types';

export interface CreateAlertInput {
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  category: 'VOLUME' | 'ANOMALY' | 'BACKUP' | 'RESTORE' | 'BTRFS' | 'SYSTEM';
  title: string;
  message: string;
  serverId?: number | null;
  jobId?: number | null;
  notifyExternal?: boolean;
}

export interface NotificationDispatchResult {
  telegramConfigured: boolean;
  telegramSent: boolean;
  emailConfigured: boolean;
  emailSent: boolean;
  errors: string[];
}

export interface DetectedTelegramChat {
  chatId: string;
  type: string;
  label: string;
}

export async function createSystemAlert(input: CreateAlertInput): Promise<SystemAlert> {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO system_alerts (severity, category, title, message, server_id, job_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.severity,
      input.category,
      input.title,
      input.message,
      input.serverId ?? null,
      input.jobId ?? null
    );

  const alert = db
    .prepare('SELECT * FROM system_alerts WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as unknown as SystemAlert;

  emitNewAlert(alert);

  if (input.notifyExternal !== false && input.severity !== 'INFO') {
    void dispatchExternalNotifications(alert);
  }

  return alert;
}

function formatFriendlyTelegramError(
  status: number,
  rawBody: string,
  chatId: string
): string {
  let desc = rawBody;
  try {
    const parsed = JSON.parse(rawBody) as { description?: string };
    if (parsed.description) desc = parsed.description;
  } catch {
    // Giữ nguyên rawBody nếu không phải JSON
  }

  const lower = desc.toLowerCase();
  if (lower.includes("can't send messages to the bot") || lower.includes('bots can\'t send messages to bots')) {
    return `Telegram lỗi (403): Bạn đang điền nhầm ID của chính con Bot (${chatId}) vào ô Chat ID! Bot không thể tự gửi tin nhắn cho chính nó. Hãy mở Telegram nhắn "/start" cho Bot rồi bấm nút "Tự lấy Chat ID".`;
  }
  if (lower.includes('chat not found')) {
    return `Telegram lỗi (400): Không tìm thấy Chat ID "${chatId}". Hãy mở Telegram tìm con Bot của bạn, bấm nút Start (hoặc gõ 1 tin nhắn vào nhóm chứa Bot) rồi thử lại.`;
  }
  if (status === 401 || lower.includes('unauthorized')) {
    return 'Telegram lỗi (401): Bot Token không hợp lệ. Vui lòng kiểm tra lại mã Token lấy từ @BotFather.';
  }
  if (lower.includes('bot was blocked by the user')) {
    return 'Telegram lỗi (403): Tài khoản người nhận đã chặn (Block) con Bot này trên Telegram.';
  }

  return `Telegram lỗi (HTTP ${status}): ${desc}`;
}

export async function detectTelegramChatId(rawBotToken: string): Promise<{
  ok: boolean;
  botUsername?: string;
  chatId?: string;
  chatLabel?: string;
  chats?: DetectedTelegramChat[];
  error?: string;
}> {
  const botToken = rawBotToken.trim().replace(/^bot/i, '');
  if (!botToken || !botToken.includes(':')) {
    return {
      ok: false,
      error: 'Vui lòng nhập đúng Telegram Bot Token (dạng 123456789:AAH...) trước khi dò Chat ID.',
    };
  }

  const botSelfId = botToken.split(':')[0]?.trim();

  try {
    const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
      cache: 'no-store',
    });
    const meJson = (await meResp.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; username?: string; first_name?: string };
    };

    if (!meResp.ok || !meJson.ok) {
      return {
        ok: false,
        error: `Bot Token không hợp lệ: ${meJson.description || `HTTP ${meResp.status}`}`,
      };
    }

    const botUsername = meJson.result?.username
      ? `@${meJson.result.username}`
      : meJson.result?.first_name || 'Bot';

    const updResp = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=30`,
      { cache: 'no-store' }
    );
    const updJson = (await updResp.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: Array<Record<string, unknown>>;
    };

    if (!updResp.ok || !updJson.ok) {
      return {
        ok: false,
        botUsername,
        error: `Không đọc được danh sách hội thoại từ ${botUsername}: ${
          updJson.description || `HTTP ${updResp.status}`
        }`,
      };
    }

    const seen = new Map<string, DetectedTelegramChat>();
    const updates = Array.isArray(updJson.result) ? [...updJson.result].reverse() : [];

    for (const u of updates) {
      const candidates = [
        (u.message as { chat?: Record<string, unknown> } | undefined)?.chat,
        (u.edited_message as { chat?: Record<string, unknown> } | undefined)?.chat,
        (u.channel_post as { chat?: Record<string, unknown> } | undefined)?.chat,
        (u.my_chat_member as { chat?: Record<string, unknown> } | undefined)?.chat,
      ];

      for (const chat of candidates) {
        if (!chat || chat.id === undefined || chat.id === null) continue;
        const idStr = String(chat.id);
        if (idStr === botSelfId || seen.has(idStr)) continue;

        const type = String(chat.type || 'private');
        const title =
          String(chat.title || '').trim() ||
          [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() ||
          String(chat.username || '').trim() ||
          idStr;
        const usernameSuffix = chat.username ? ` (@${String(chat.username)})` : '';
        seen.set(idStr, {
          chatId: idStr,
          type,
          label: `${title}${usernameSuffix} [${type}]`,
        });
      }
    }

    const chats = Array.from(seen.values());
    if (chats.length === 0) {
      return {
        ok: false,
        botUsername,
        error: `Bot ${botUsername} hợp lệ nhưng chưa nhận được tin nhắn nào! Hãy mở Telegram tìm ${botUsername}, bấm nút START (hoặc gõ 1 tin nhắn bất kỳ vào Nhóm có Bot), sau đó bấm lại "Tự lấy Chat ID".`,
      };
    }

    return {
      ok: true,
      botUsername,
      chatId: chats[0].chatId,
      chatLabel: chats[0].label,
      chats,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Lỗi kết nối tới máy chủ Telegram: ${(err as Error).message}`,
    };
  }
}

export async function dispatchExternalNotifications(alert: {
  severity: string;
  category: string;
  title: string;
  message: string;
}): Promise<NotificationDispatchResult> {
  const errors: string[] = [];
  let telegramSent = false;
  let emailSent = false;

  const icon =
    alert.severity === 'CRITICAL'
      ? '🚨'
      : alert.severity === 'WARNING'
      ? '⚠️'
      : '✅';

  // 1. Telegram Notification
  const botToken = getSetting('telegram_bot_token').trim().replace(/^bot/i, '');
  const chatId = getSetting('telegram_chat_id').trim();
  const telegramConfigured = Boolean(botToken && chatId);

  if (telegramConfigured) {
    const botSelfId = botToken.split(':')[0]?.trim();
    if (botSelfId && chatId === botSelfId) {
      errors.push(
        `Telegram lỗi: Bạn đang nhập nhầm ID của chính con Bot (${chatId}) vào ô "Telegram Chat ID"! Bot không thể tự nhắn tin cho chính nó. Hãy mở Telegram nhắn "/start" cho Bot rồi bấm nút "Tự lấy Chat ID".`
      );
    } else {
      try {
        const text = `${icon} <b>[NAS-Sync - ${alert.category}]</b>\n<b>${escapeHtml(
          alert.title
        )}</b>\n\n${escapeHtml(alert.message)}\n\n🕒 ${new Date().toLocaleString('vi-VN')}`;

        const resp = await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            }),
          }
        );
        if (resp.ok) {
          telegramSent = true;
        } else {
          const errBody = await resp.text();
          errors.push(formatFriendlyTelegramError(resp.status, errBody, chatId));
        }
      } catch (err) {
        errors.push(`Telegram lỗi kết nối: ${(err as Error).message}`);
      }
    }
  } else if (botToken && !chatId) {
    errors.push('Telegram: Đã nhập Bot Token nhưng còn thiếu Telegram Chat ID.');
  } else if (!botToken && chatId) {
    errors.push('Telegram: Đã nhập Chat ID nhưng còn thiếu Telegram Bot Token.');
  }

  // 2. SMTP Email Notification
  const smtpHost = getSetting('smtp_host').trim();
  const smtpPort = Number(getSetting('smtp_port', '587'));
  const smtpUser = getSetting('smtp_user').trim();
  const smtpPass = getSetting('smtp_pass');
  const smtpFrom = getSetting('smtp_from', smtpUser || 'noreply@nas-sync.local').trim();
  const alertEmailTo = getSetting('alert_email_to').trim();
  const emailConfigured = Boolean(smtpHost && alertEmailTo);

  if (emailConfigured) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
      });

      await transporter.sendMail({
        from: `"NAS-Sync Backup" <${smtpFrom}>`,
        to: alertEmailTo,
        subject: `${icon} [NAS-Sync] ${alert.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background: #0f172a; color: #f8fafc; padding: 16px 20px;">
              <h2 style="margin: 0; font-size: 18px;">${icon} NAS-Sync — ${escapeHtml(
          alert.category
        )}</h2>
            </div>
            <div style="padding: 20px; color: #1e293b; line-height: 1.6;">
              <h3 style="margin-top: 0;">${escapeHtml(alert.title)}</h3>
              <p style="white-space: pre-line;">${escapeHtml(alert.message)}</p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
              <small style="color: #64748b;">Thời gian: ${new Date().toLocaleString(
                'vi-VN'
              )} | Hệ thống: ${process.env.APP_URL || 'NAS-Sync'}</small>
            </div>
          </div>
        `,
      });
      emailSent = true;
    } catch (err) {
      errors.push(`SMTP Email lỗi: ${(err as Error).message}`);
    }
  }

  return {
    telegramConfigured,
    telegramSent,
    emailConfigured,
    emailSent,
    errors,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

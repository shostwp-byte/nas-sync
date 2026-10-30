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

export async function dispatchExternalNotifications(alert: {
  severity: string;
  category: string;
  title: string;
  message: string;
}): Promise<{ telegramSent: boolean; emailSent: boolean; errors: string[] }> {
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
  const botToken = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (botToken && chatId) {
    try {
      const text = `${icon} <b>[SHOST Backup - ${alert.category}]</b>\n<b>${escapeHtml(
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
        errors.push(`Telegram HTTP ${resp.status}: ${errBody}`);
      }
    } catch (err) {
      errors.push(`Telegram error: ${(err as Error).message}`);
    }
  }

  // 2. SMTP Email Notification
  const smtpHost = getSetting('smtp_host');
  const smtpPort = Number(getSetting('smtp_port', '587'));
  const smtpUser = getSetting('smtp_user');
  const smtpPass = getSetting('smtp_pass');
  const smtpFrom = getSetting('smtp_from', 'backup@shost.vn');
  const alertEmailTo = getSetting('alert_email_to');

  if (smtpHost && alertEmailTo) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
      });

      await transporter.sendMail({
        from: `"SHOST Backup Platform" <${smtpFrom}>`,
        to: alertEmailTo,
        subject: `${icon} [SHOST Backup] ${alert.title}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background: #0f172a; color: #f8fafc; padding: 16px 20px;">
              <h2 style="margin: 0; font-size: 18px;">${icon} SHOST Backup Platform — ${escapeHtml(
          alert.category
        )}</h2>
            </div>
            <div style="padding: 20px; color: #1e293b; line-height: 1.6;">
              <h3 style="margin-top: 0;">${escapeHtml(alert.title)}</h3>
              <p style="white-space: pre-line;">${escapeHtml(alert.message)}</p>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
              <small style="color: #64748b;">Thời gian: ${new Date().toLocaleString(
                'vi-VN'
              )} | Hệ thống: ${process.env.APP_URL || 'https://backup.shost.vn'}</small>
            </div>
          </div>
        `,
      });
      emailSent = true;
    } catch (err) {
      errors.push(`SMTP error: ${(err as Error).message}`);
    }
  }

  return { telegramSent, emailSent, errors };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


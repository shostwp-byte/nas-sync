'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  BellRing,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  KeyRound,
  Lock,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import { useRealtime } from '@/components/SocketProvider';
import { formatDateTime } from '@/lib/format';
import type { SystemAlert, SystemUpdateInfo } from '@/types';

export default function SettingsPage() {
  const { updateProgress, updateLogs, clearUpdateLogs } = useRealtime();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [saving, setSaving] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [detectingChatId, setDetectingChatId] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [notifyStatus, setNotifyStatus] = useState<{
    ok: boolean;
    summary: string;
    details?: string[];
  } | null>(null);

  // GitHub Updater State
  const [updateInfo, setUpdateInfo] = useState<SystemUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);

  const [adminUsername, setAdminUsername] = useState('admin');
  const [newUsername, setNewUsername] = useState('admin');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [changingPwd, setChangingPwd] = useState(false);
  const [pwdStatus, setPwdStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    const [settingsResp, meResp] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/auth/me'),
    ]);
    if (settingsResp.ok) {
      const json = await settingsResp.json();
      setSettings(json.settings || {});
      setAlerts(json.alerts || []);
    }
    if (meResp.ok) {
      const meJson = await meResp.json();
      if (meJson?.user?.username) {
        setAdminUsername(String(meJson.user.username));
        setNewUsername(String(meJson.user.username));
      }
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      const resp = await fetch('/api/system/update', { cache: 'no-store' });
      if (resp.ok) {
        const info = (await resp.json()) as SystemUpdateInfo;
        setUpdateInfo(info);
      }
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    void handleCheckUpdate();
  }, [loadData, handleCheckUpdate]);

  // Tự động kiểm tra dịch vụ và tải lại trình duyệt sau khi container khởi động lại hoàn tất
  useEffect(() => {
    if (updateProgress?.status !== 'RESTARTING') return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          clearInterval(timer);
          window.location.reload();
        }
      } catch {
        // Đang khởi động lại container...
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [updateProgress?.status]);

  const handleStartGitHubUpdate = async () => {
    const confirmMsg = updateInfo?.hasUpdate
      ? `Hệ thống sẽ tự động sao lưu CSDL, tải phiên bản mới (v${updateInfo.latestVersion}) từ GitHub và tự khởi động lại dịch vụ (~30-60 giây). Tiếp tục?`
      : 'Bạn đang ở phiên bản mới nhất. Bạn có muốn tải và biên dịch đồng bộ lại mã nguồn mới nhất từ nhánh main trên GitHub không?';

    if (!confirm(confirmMsg)) return;

    clearUpdateLogs();
    setTriggeringUpdate(true);
    try {
      const resp = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: false }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        alert(json.error || 'Không thể bắt đầu tiến trình cập nhật.');
      }
    } finally {
      setTriggeringUpdate(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback('');
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (resp.ok) {
        setFeedback('✅ Đã lưu toàn bộ cấu hình hệ thống thành công!');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDetectTelegramChatId = async () => {
    setDetectingChatId(true);
    setNotifyStatus(null);
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'detect_telegram_chat_id',
          botToken: settings.telegram_bot_token || '',
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        setNotifyStatus({
          ok: false,
          summary:
            json.error ||
            'Không thể tự động lấy Chat ID. Hãy nhắn "/start" cho Bot trên Telegram trước.',
        });
        return;
      }
      if (json.chatId) {
        updateField('telegram_chat_id', String(json.chatId));
      }
      setNotifyStatus({
        ok: true,
        summary: `✅ Đã tự động điền Chat ID: ${json.chatId} — ${
          json.chatLabel || ''
        } (Bot ${json.botUsername || ''}). Bấm "Gửi Tin nhắn Test" để kiểm tra!`,
      });
    } catch (err) {
      setNotifyStatus({
        ok: false,
        summary: (err as Error).message || 'Lỗi kết nối khi dò Chat ID.',
      });
    } finally {
      setDetectingChatId(false);
    }
  };

  const handleTestNotification = async () => {
    setTestingNotify(true);
    setFeedback('');
    setNotifyStatus(null);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test_notification' }),
      });
      const json = await resp.json();

      const tgLabel = json.telegramSent
        ? 'Thành công ✅'
        : json.telegramConfigured
        ? 'Gửi thất bại ❌'
        : 'Bỏ qua (Chưa nhập)';

      const mailLabel = json.emailSent
        ? 'Thành công ✅'
        : json.emailConfigured
        ? 'Gửi thất bại ❌'
        : 'Bỏ qua (Chưa nhập)';

      const anySuccess = Boolean(json.telegramSent || json.emailSent);
      const hasErrors = Array.isArray(json.errors) && json.errors.length > 0;

      setNotifyStatus({
        ok: anySuccess && !hasErrors,
        summary: `Kết quả kiểm tra — Telegram: ${tgLabel} | SMTP Email: ${mailLabel}`,
        details: hasErrors ? (json.errors as string[]) : undefined,
      });
    } finally {
      setTestingNotify(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangingPwd(true);
    setPwdStatus(null);
    try {
      const resp = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword,
          newUsername: newUsername.trim(),
          newPassword,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setPwdStatus({
          ok: false,
          message:
            json.error || `Cập nhật tài khoản thất bại (Mã ${resp.status}).`,
        });
        return;
      }
      if (json.username) {
        setAdminUsername(String(json.username));
        setNewUsername(String(json.username));
      }
      setCurrentPassword('');
      setNewPassword('');
      setPwdStatus({
        ok: true,
        message:
          json.message || '✅ Đã cập nhật thông tin tài khoản Admin thành công!',
      });
    } catch (err) {
      setPwdStatus({
        ok: false,
        message: (err as Error).message || 'Lỗi kết nối khi cập nhật tài khoản.',
      });
    } finally {
      setChangingPwd(false);
    }
  };

  const markAlertsRead = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_all_read' }),
    });
    await loadData();
  };

  const updateField = (key: string, val: string) => {
    setSettings((prev) => ({ ...prev, [key]: val }));
  };

  const isUpdatingNow =
    triggeringUpdate ||
    Boolean(updateInfo?.updateInProgress) ||
    (updateProgress !== null &&
      !['IDLE', 'COMPLETED', 'FAILED'].includes(updateProgress.status));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Settings className="w-5 h-5 text-blue-400" />
          Cấu hình Hệ thống, Cập nhật GitHub & Bảo mật Chống Ransomware
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Quản lý cập nhật 1-Click từ GitHub (shostwp-byte/nas-sync), Telegram Bot, SMTP Email và Synology DSM Btrfs WORM API.
        </p>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl bg-blue-500/15 border border-blue-500/30 text-xs text-blue-200">
          {feedback}
        </div>
      )}

      {/* 1-Click GitHub Self-Updater Card */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 text-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-emerald-400" />
              Cập nhật Hệ thống Trực tiếp từ GitHub (1-Click Self-Update)
            </h3>
            <p className="text-slate-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span>Kho mã nguồn chính thức:</span>
              <a
                href={updateInfo?.repoUrl || 'https://github.com/shostwp-byte/nas-sync'}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-400 hover:underline inline-flex items-center gap-1 font-mono"
              >
                github.com/shostwp-byte/nas-sync
                <ExternalLink className="w-3 h-3" />
              </a>
              <span className="text-slate-500">• Giấy phép MIT (Miễn phí 100%)</span>
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void handleCheckUpdate()}
              disabled={checkingUpdate || isUpdatingNow}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${checkingUpdate ? 'animate-spin' : ''}`}
              />
              {checkingUpdate ? 'Đang kiểm tra...' : 'Kiểm tra bản mới'}
            </button>

            <button
              type="button"
              onClick={() => void handleStartGitHubUpdate()}
              disabled={
                isUpdatingNow || (updateInfo !== null && !updateInfo.canUpdateNow)
              }
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-semibold transition-all disabled:opacity-50 ${
                updateInfo?.hasUpdate
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                  : 'bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30'
              }`}
            >
              <ArrowUpCircle className="w-4 h-4" />
              {isUpdatingNow
                ? 'Đang cập nhật...'
                : updateInfo?.hasUpdate
                ? `Cập nhật ngay lên v${updateInfo.latestVersion}`
                : 'Đồng bộ lại từ GitHub (main)'}
            </button>
          </div>
        </div>

        {updateInfo && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800">
              <div className="text-slate-400">Phiên bản đang chạy trên NAS</div>
              <div className="text-sm font-bold text-white mt-1 font-mono flex items-center gap-2">
                <span>v{updateInfo.currentVersion}</span>
                {updateInfo.currentCommit && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    #{updateInfo.currentCommit}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800">
              <div className="text-slate-400">Phiên bản mới nhất trên GitHub</div>
              <div className="text-sm font-bold text-cyan-300 mt-1 font-mono flex items-center gap-2">
                <span>v{updateInfo.latestVersion}</span>
                {updateInfo.latestCommit && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">
                    #{updateInfo.latestCommit}
                  </span>
                )}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-slate-400">Trạng thái đồng bộ</div>
                {updateInfo.hasUpdate ? (
                  <div className="text-amber-300 font-semibold mt-1">
                    🚀 Có bản cập nhật mới sẵn sàng!
                  </div>
                ) : (
                  <div className="text-emerald-400 font-semibold mt-1 flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    Đang ở bản mới nhất
                  </div>
                )}
              </div>
              {updateInfo.latestPublishedAt && (
                <div className="text-[11px] text-slate-500 text-right">
                  Cập nhật cuối:
                  <br />
                  {formatDateTime(updateInfo.latestPublishedAt)}
                </div>
              )}
            </div>
          </div>
        )}

        {updateInfo?.blockingReason && (
          <div className="p-3 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200">
            ⚠️ {updateInfo.blockingReason}
          </div>
        )}

        {updateInfo?.changelog && (
          <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 space-y-1">
            <div className="text-[11px] font-semibold text-slate-300">
              {updateInfo.releaseTitle || 'Ghi chú Commit / Phiên bản mới nhất trên GitHub:'}
            </div>
            <pre className="text-[11px] text-slate-400 whitespace-pre-wrap font-mono max-h-28 overflow-y-auto">
              {updateInfo.changelog}
            </pre>
          </div>
        )}

        {updateProgress && (
          <div className="p-4 rounded-xl bg-slate-950 border border-blue-500/30 space-y-3">
            <div className="flex items-center justify-between">
              <span
                className={`font-semibold ${
                  updateProgress.status === 'FAILED'
                    ? 'text-rose-400'
                    : updateProgress.status === 'COMPLETED' ||
                      updateProgress.status === 'RESTARTING'
                    ? 'text-emerald-400'
                    : 'text-blue-300'
                }`}
              >
                {updateProgress.message}
              </span>
              <span className="font-mono text-slate-300">
                {updateProgress.percent}%
              </span>
            </div>

            <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  updateProgress.status === 'FAILED'
                    ? 'bg-rose-500'
                    : 'bg-gradient-to-r from-blue-500 to-emerald-400'
                }`}
                style={{ width: `${Math.max(4, updateProgress.percent)}%` }}
              />
            </div>

            {updateLogs.length > 0 && (
              <pre className="p-3 rounded-lg bg-black/70 border border-slate-800 text-[11px] text-slate-300 font-mono max-h-44 overflow-y-auto">
                {updateLogs.join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      <form onSubmit={handleSaveSettings} className="space-y-6 text-xs">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Telegram & SMTP */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <BellRing className="w-4 h-4 text-cyan-400" />
                Cảnh báo Telegram & Báo cáo SMTP Email
              </h3>
              <button
                type="button"
                onClick={() => void handleTestNotification()}
                disabled={testingNotify}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" />
                {testingNotify ? 'Đang gửi...' : 'Gửi Tin nhắn Test'}
              </button>
            </div>

            {notifyStatus && (
              <div
                className={`p-3 rounded-xl border text-xs space-y-1.5 ${
                  notifyStatus.ok
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                    : 'bg-rose-500/15 border-rose-500/30 text-rose-200'
                }`}
              >
                <div className="font-semibold">{notifyStatus.summary}</div>
                {notifyStatus.details && notifyStatus.details.length > 0 && (
                  <ul className="list-disc pl-4 space-y-1 text-[11px] text-rose-100/90">
                    {notifyStatus.details.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">
                  Telegram Bot Token
                </label>
                <input
                  value={settings.telegram_bot_token || ''}
                  onChange={(e) =>
                    updateField('telegram_bot_token', e.target.value)
                  }
                  placeholder="123456789:AAH..."
                  autoComplete="off"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-slate-400">
                    Telegram Chat ID / Group ID
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleDetectTelegramChatId()}
                    disabled={detectingChatId}
                    className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-medium disabled:opacity-50"
                  >
                    <Search className="w-3 h-3" />
                    {detectingChatId ? 'Đang dò...' : 'Tự lấy Chat ID'}
                  </button>
                </div>
                <input
                  value={settings.telegram_chat_id || ''}
                  onChange={(e) =>
                    updateField('telegram_chat_id', e.target.value)
                  }
                  placeholder="VD: 987654321 hoặc -1001987654321"
                  autoComplete="off"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 -mt-1">
              Mẹo: Nhập <b>Bot Token</b>, mở Telegram nhắn <code>/start</code> cho con Bot đó (không điền mã số đầu của Token vào Chat ID), rồi bấm <b>Tự lấy Chat ID</b>.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
              <div className="sm:col-span-2">
                <label className="block text-slate-400 mb-1">SMTP Host</label>
                <input
                  value={settings.smtp_host || ''}
                  onChange={(e) => updateField('smtp_host', e.target.value)}
                  placeholder="smtp.gmail.com"
                  autoComplete="off"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">SMTP Port</label>
                <input
                  value={settings.smtp_port || '587'}
                  onChange={(e) => updateField('smtp_port', e.target.value)}
                  autoComplete="off"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">SMTP User</label>
                <input
                  name="smtp_auth_user"
                  autoComplete="off"
                  value={settings.smtp_user || ''}
                  onChange={(e) => updateField('smtp_user', e.target.value)}
                  placeholder="alerts@example.com"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">
                  SMTP Password
                </label>
                <input
                  name="smtp_auth_pass"
                  type="password"
                  autoComplete="new-password"
                  value={settings.smtp_pass || ''}
                  onChange={(e) => updateField('smtp_pass', e.target.value)}
                  placeholder="App Password (16 ký tự)"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-400 mb-1">
                Email nhận cảnh báo khẩn cấp
              </label>
              <input
                value={settings.alert_email_to || ''}
                onChange={(e) => updateField('alert_email_to', e.target.value)}
                placeholder="noc@shost.vn"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
              />
            </div>
          </div>

          {/* Anomaly Detection & Synology DSM Btrfs API */}
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-amber-400" />
                Ngưỡng Phát hiện Sớm Ransomware (Anomaly Detection)
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Tỷ lệ file thay đổi tối đa / ngày (%)
                  </label>
                  <input
                    type="number"
                    value={settings.anomaly_max_changed_percent || '50'}
                    onChange={(e) =>
                      updateField('anomaly_max_changed_percent', e.target.value)
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">
                    Dung lượng tăng đột biến tối đa (GB)
                  </label>
                  <input
                    type="number"
                    value={settings.anomaly_max_delta_gb || '10'}
                    onChange={(e) =>
                      updateField('anomaly_max_delta_gb', e.target.value)
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>
              <p className="text-[11px] text-slate-500">
                Khi vượt ngưỡng, hệ thống gửi cảnh báo Telegram khẩn cấp và tự động khóa (Pin) toàn bộ các bản sao lưu sạch trước đó.
              </p>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Lock className="w-4 h-4 text-emerald-400" />
                Tích hợp Synology DSM Btrfs Immutable Snapshot (WORM)
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Synology DSM URL
                  </label>
                  <input
                    value={settings.dsm_api_url || ''}
                    onChange={(e) => updateField('dsm_api_url', e.target.value)}
                    placeholder="https://192.168.1.10:5001"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">
                    Shared Folders (cách nhau dấu phẩy)
                  </label>
                  <input
                    value={settings.dsm_backup_shares || 'VPS_Backups'}
                    onChange={(e) =>
                      updateField('dsm_backup_shares', e.target.value)
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">
                    DSM Admin User
                  </label>
                  <input
                    value={settings.dsm_username || ''}
                    onChange={(e) =>
                      updateField('dsm_username', e.target.value)
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">
                    DSM Password
                  </label>
                  <input
                    type="password"
                    value={settings.dsm_password || ''}
                    onChange={(e) =>
                      updateField('dsm_password', e.target.value)
                    }
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.btrfs_auto_enabled === 'true'}
                  onChange={(e) =>
                    updateField(
                      'btrfs_auto_enabled',
                      e.target.checked ? 'true' : 'false'
                    )
                  }
                />
                <span>
                  Tự động tạo Btrfs WORM Snapshot lúc 06:00 AM hàng ngày (Khóa chống xóa 7 ngày)
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-sm shadow-lg shadow-blue-600/20"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Đang lưu...' : 'Lưu Toàn bộ Cấu hình'}
          </button>
        </div>
      </form>

      {/* Password & Alert Log */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 text-xs">
        <form
          onSubmit={handleChangePassword}
          className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-amber-400" />
              Tài khoản & Mật khẩu Quản trị
            </h3>
            <button
              type="button"
              onClick={() => setShowPasswords((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"
            >
              {showPasswords ? (
                <>
                  <EyeOff className="w-3.5 h-3.5" /> Ẩn
                </>
              ) : (
                <>
                  <Eye className="w-3.5 h-3.5" /> Hiện
                </>
              )}
            </button>
          </div>

          {pwdStatus && (
            <div
              className={`p-3 rounded-xl border text-xs ${
                pwdStatus.ok
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                  : 'bg-rose-500/15 border-rose-500/30 text-rose-200'
              }`}
            >
              {pwdStatus.message}
            </div>
          )}

          <div>
            <label className="block text-slate-400 mb-1">
              Tên đăng nhập (Username) — hiện tại:{' '}
              <span className="text-cyan-400 font-mono">{adminUsername}</span>
            </label>
            <input
              type="text"
              required
              minLength={3}
              maxLength={32}
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="VD: dungtran"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">
              Mật khẩu hiện tại (bắt buộc để xác nhận)
            </label>
            <input
              type={showPasswords ? 'text' : 'password'}
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Nhập mật khẩu đang dùng..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">
              Mật khẩu mới (để trống nếu chỉ đổi Username)
            </label>
            <input
              type={showPasswords ? 'text' : 'password'}
              minLength={6}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Để trống hoặc nhập tối thiểu 6 ký tự..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
            />
          </div>
          <button
            type="submit"
            disabled={changingPwd}
            className="w-full py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold border border-slate-700"
          >
            {changingPwd ? 'Đang cập nhật...' : 'Cập nhật Tài khoản Quản trị'}
          </button>
        </form>

        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white">
              Nhật ký Sự kiện & Cảnh báo Hệ thống Gần đây
            </h3>
            <button
              onClick={() => void markAlertsRead()}
              className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
            >
              <CheckCheck className="w-3.5 h-3.5" />
              Đánh dấu đã đọc
            </button>
          </div>

          <div className="space-y-2.5 max-h-60 overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="text-slate-500 py-6 text-center">
                Chưa có cảnh báo hệ thống nào.
              </div>
            ) : (
              alerts.map((a) => (
                <div
                  key={a.id}
                  className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex items-start justify-between gap-3"
                >
                  <div>
                    <div className="font-semibold text-white">
                      [{a.category}] {a.title}
                    </div>
                    <p className="text-slate-400 mt-0.5">{a.message}</p>
                  </div>
                  <span className="text-[10px] text-slate-500 shrink-0">
                    {formatDateTime(a.created_at)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

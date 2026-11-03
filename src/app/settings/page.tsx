'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  BellRing,
  CalendarClock,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Filter,
  GitBranch,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { useRealtime } from '@/components/SocketProvider';
import { formatBytes, formatDateTime, formatEta } from '@/lib/format';
import type {
  MorningDigestSummary,
  OffsiteProviderType,
  OffsiteSyncJob,
  OffsiteSyncStatus,
  SystemUpdateInfo,
  UserRecord,
  UserRole,
} from '@/types';

type SettingsTab = 'config' | 'backup' | 'account' | 'rbac' | 'update';

const EMERGENCY_DECRYPT_CMD =
  'node scripts/decrypt-offsite-backup.mjs <file.tar.gz.enc> <out.tar.gz> "<passphrase>"';

const DIGEST_CRON_PRESETS = [
  { label: '06:00', cron: '0 6 * * *' },
  { label: '06:30', cron: '30 6 * * *' },
  { label: '07:00', cron: '0 7 * * *' },
  { label: '07:30', cron: '30 7 * * *' },
  { label: '08:00', cron: '0 8 * * *' },
];

const STANDARD_WP_EXCLUDES = [
  'wp-content/cache/',
  'wp-content/litespeed/',
  'wp-content/updraft/',
  'wp-content/ai1wm-backups/*.wpress',
  'wp-content/backups-dup-pro/',
  'storage/logs/*.log',
  '*.log',
  'error_log',
  'core.[0-9]*',
];

async function copyTextSafe(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function getRoleBadgeClass(role: UserRole): string {
  switch (role) {
    case 'ADMIN':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'OPERATOR':
      return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
    case 'VIEWER':
      return 'bg-slate-700/60 text-slate-300 border-slate-600/60';
    default:
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
  }
}

function getOffsiteStatusMeta(status: OffsiteSyncStatus | string): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'COMPLETED':
      return {
        label: 'Hoàn tất',
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      };
    case 'UPLOADING':
      return {
        label: 'Đang tải lên',
        className: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
      };
    case 'QUEUED':
      return {
        label: 'Đang chờ',
        className: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
      };
    case 'FAILED':
      return {
        label: 'Thất bại',
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      };
    default:
      return {
        label: status,
        className: 'bg-slate-700 text-slate-300 border-slate-600',
      };
  }
}

export default function SettingsPage() {
  const { updateProgress, updateLogs, clearUpdateLogs, lastUpdateCounter } =
    useRealtime();

  // Current User & Active Tab
  const [currentUser, setCurrentUser] = useState<{
    userId: number;
    username: string;
    role: UserRole;
    totpEnabled: boolean;
  } | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('config');

  // System Settings (Tab 1)
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testingNotify, setTestingNotify] = useState(false);
  const [detectingChatId, setDetectingChatId] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [notifyStatus, setNotifyStatus] = useState<{
    ok: boolean;
    summary: string;
    details?: string[];
  } | null>(null);
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [showSmtpPass, setShowSmtpPass] = useState(false);
  const [showWormSecret, setShowWormSecret] = useState(false);

  // Daily Morning Digest State (Tab 1)
  const [testingDigest, setTestingDigest] = useState(false);
  const [digestResult, setDigestResult] = useState<{
    ok: boolean;
    message: string;
    telegramSent?: boolean;
    emailSent?: boolean;
    errors?: string[];
    summary?: MorningDigestSummary;
  } | null>(null);

  // GitHub Updater State (Tab 1)
  const [updateInfo, setUpdateInfo] = useState<SystemUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);

  // Offsite Cloud Backup 3-2-1 State (Tab 1)
  const [offsiteJobs, setOffsiteJobs] = useState<OffsiteSyncJob[]>([]);
  const [offsiteJobsLoading, setOffsiteJobsLoading] = useState(false);
  const [testingOffsite, setTestingOffsite] = useState(false);
  const [offsiteTestResult, setOffsiteTestResult] = useState<{
    ok: boolean;
    providerLabel?: string;
    detail?: string;
    error?: string;
  } | null>(null);
  const [connectingGdriveOAuth, setConnectingGdriveOAuth] = useState(false);
  const [gdriveOAuthBanner, setGdriveOAuthBanner] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [appOrigin, setAppOrigin] = useState('');
  const [copiedRedirectUri, setCopiedRedirectUri] = useState(false);
  const [copiedDecryptCmd, setCopiedDecryptCmd] = useState(false);
  const [showOffsitePassphrase, setShowOffsitePassphrase] = useState(false);
  const [showS3SecretKey, setShowS3SecretKey] = useState(false);
  const [showGdriveClientSecret, setShowGdriveClientSecret] = useState(false);
  const [showGdriveRefreshToken, setShowGdriveRefreshToken] = useState(false);

  // Personal Account Password / Username State (Tab 2)
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

  // 2FA TOTP Setup & Management State (Tab 2)
  const [twoFaState, setTwoFaState] = useState<{
    enabled: boolean;
    recoveryCodesRemaining: number;
  }>({ enabled: false, recoveryCodesRemaining: 0 });
  const [twoFaLoading, setTwoFaLoading] = useState(false);
  const [twoFaMessage, setTwoFaMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [twoFaSetupPassword, setTwoFaSetupPassword] = useState('');
  const [setupData, setSetupData] = useState<{
    qrSvg: string;
    secret: string;
  } | null>(null);
  const [twoFaVerifyCode, setTwoFaVerifyCode] = useState('');
  const [freshRecoveryCodes, setFreshRecoveryCodes] = useState<string[]>([]);
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);
  const [twoFaManageAction, setTwoFaManageAction] = useState<
    'none' | 'regenerate' | 'disable'
  >('none');
  const [twoFaActionPassword, setTwoFaActionPassword] = useState('');
  const [twoFaActionCode, setTwoFaActionCode] = useState('');

  // Multi-User RBAC State (Tab 3)
  const [usersList, setUsersList] = useState<UserRecord[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [rbacFeedback, setRbacFeedback] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [createUserForm, setCreateUserForm] = useState<{
    username: string;
    password: string;
    role: UserRole;
  }>({
    username: '',
    password: '',
    role: 'OPERATOR',
  });
  const [showNewUserPass, setShowNewUserPass] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [resetPassTarget, setResetPassTarget] = useState<UserRecord | null>(
    null
  );
  const [resetSecurityMode, setResetSecurityMode] = useState<
    'password' | '2fa'
  >('password');
  const [resetPassValue, setResetPassValue] = useState('');
  const [resetAdminPassword, setResetAdminPassword] = useState('');
  const [resetAdminTotpCode, setResetAdminTotpCode] = useState('');
  const [resettingPass, setResettingPass] = useState(false);

  const isAdmin = !currentUser || currentUser.role === 'ADMIN';

  const loadTwoFaStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/auth/2fa', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        setTwoFaState({
          enabled: Boolean(json.enabled),
          recoveryCodesRemaining: Number(json.recoveryCodesRemaining || 0),
        });
      }
    } catch {
      // Ignore network hiccup
    }
  }, []);

  const loadAdminSettings = useCallback(async () => {
    const settingsResp = await fetch('/api/settings');
    if (settingsResp.ok) {
      const json = await settingsResp.json();
      setSettings(json.settings || {});
    }
  }, []);

  const loadOffsiteJobs = useCallback(async () => {
    setOffsiteJobsLoading(true);
    try {
      const resp = await fetch('/api/offsite', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        setOffsiteJobs(json.jobs || []);
      }
    } catch {
      // Ignore transient network hiccup
    } finally {
      setOffsiteJobsLoading(false);
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

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const resp = await fetch('/api/users', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        setUsersList(json.users || []);
      }
    } finally {
      setUsersLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const meResp = await fetch('/api/auth/me', { cache: 'no-store' });
        let role: UserRole = 'ADMIN';
        if (meResp.ok) {
          const meJson = await meResp.json();
          if (active && meJson?.user) {
            role = (meJson.user.role as UserRole) || 'ADMIN';
            const uname = String(meJson.user.username || 'admin');
            setCurrentUser({
              userId: Number(meJson.user.userId ?? meJson.user.id ?? 0),
              username: uname,
              role,
              totpEnabled: Boolean(
                meJson.user.totpEnabled ?? meJson.user.totp_enabled
              ),
            });
            setAdminUsername(uname);
            setNewUsername(uname);
          }
        }

        await loadTwoFaStatus();

        if (!active) return;
        if (role !== 'ADMIN') {
          setActiveTab('account');
        } else {
          await Promise.all([
            loadAdminSettings(),
            loadOffsiteJobs(),
            handleCheckUpdate(),
          ]);
        }
      } catch {
        // Ignore transient init errors
      }
    };
    void init();
    return () => {
      active = false;
    };
  }, [loadTwoFaStatus, loadAdminSettings, loadOffsiteJobs, handleCheckUpdate]);

  // Detect query params (?tab=update|account|... and Google Drive OAuth2 callback ?gdrive=...)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setAppOrigin(window.location.origin);
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    if (
      tabParam === 'config' ||
      tabParam === 'backup' ||
      tabParam === 'account' ||
      tabParam === 'rbac' ||
      tabParam === 'update'
    ) {
      setActiveTab(tabParam);
    }
    const gdrive = params.get('gdrive');
    const gdriveError = params.get('gdrive_error');
    if (gdrive === 'connected') {
      setGdriveOAuthBanner({
        ok: true,
        text: '✅ Đã liên kết tài khoản Google Drive thành công!',
      });
      setActiveTab('backup');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (gdriveError) {
      setGdriveOAuthBanner({
        ok: false,
        text: `❌ Liên kết tài khoản Google Drive thất bại: ${gdriveError}`,
      });
      setActiveTab('backup');
      window.history.replaceState({}, '', window.location.pathname);
    }

    const handleTabEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<SettingsTab>).detail;
      if (detail) {
        setFeedback('');
        setActiveTab(detail);
      }
    };
    window.addEventListener('nas-sync:settings-tab', handleTabEvent);
    return () => {
      window.removeEventListener('nas-sync:settings-tab', handleTabEvent);
    };
  }, []);

  // Auto-refresh Offsite sync transfers when realtime events arrive or while an upload is active
  useEffect(() => {
    if (!isAdmin || activeTab !== 'backup' || lastUpdateCounter === 0) return;
    void loadOffsiteJobs();
  }, [isAdmin, activeTab, lastUpdateCounter, loadOffsiteJobs]);

  useEffect(() => {
    if (!isAdmin || activeTab !== 'backup') return;
    const hasActiveUpload = offsiteJobs.some(
      (j) => j.status === 'QUEUED' || j.status === 'UPLOADING'
    );
    if (!hasActiveUpload) return;
    const timer = setInterval(() => {
      void loadOffsiteJobs();
    }, 4000);
    return () => clearInterval(timer);
  }, [isAdmin, activeTab, offsiteJobs, loadOffsiteJobs]);

  useEffect(() => {
    if (!currentUser || currentUser.role !== 'ADMIN') return;
    if (activeTab === 'backup') {
      void loadOffsiteJobs();
    } else if (activeTab === 'rbac') {
      void loadUsers();
    }
  }, [activeTab, currentUser, loadOffsiteJobs, loadUsers]);

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
      ? `Hệ thống sẽ tự động sao lưu CSDL, tải phiên bản mới (v${updateInfo.latestVersion}) từ GitHub và tự khởi động lại dịch vụ. Tiếp tục?`
      : 'Bạn đang ở phiên bản mới nhất. Bạn có muốn tải và đồng bộ lại bản phát hành mới nhất từ GitHub không?';

    if (!confirm(confirmMsg)) return;

    clearUpdateLogs();
    setTriggeringUpdate(true);
    try {
      const resp = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !updateInfo?.hasUpdate }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        alert(json.error || 'Không thể bắt đầu tiến trình cập nhật.');
      }
    } finally {
      setTriggeringUpdate(false);
    }
  };

  const handleStartRollback = async () => {
    const targetVer = updateInfo?.rollbackVersion || 'trước';
    if (
      !confirm(
        `Xác nhận quay lại phiên bản v${targetVer}? Hệ thống sẽ khôi phục gói dự phòng và tự động khởi động lại dịch vụ.`
      )
    ) {
      return;
    }

    clearUpdateLogs();
    setTriggeringUpdate(true);
    try {
      const resp = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback' }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        alert(json.error || 'Không thể thực hiện Rollback.');
      }
    } finally {
      setTriggeringUpdate(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback('');

    const activeOffsiteProvider = (settings.offsite_provider ||
      'NONE') as OffsiteProviderType;
    if (activeOffsiteProvider !== 'NONE') {
      const pass = (settings.offsite_encryption_passphrase || '').trim();
      if (pass.length < 8) {
        setFeedback(
          '❌ Mật khẩu Mã hóa Đầu-Cuối AES-256-GCM cho Đám mây Offsite phải có tối thiểu 8 ký tự.'
        );
        return;
      }
    }

    setSaving(true);
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (resp.ok) {
        setFeedback('✅ Đã lưu toàn bộ cấu hình hệ thống thành công!');
        await loadAdminSettings();
      } else {
        const json = await resp.json().catch(() => ({}));
        setFeedback(`❌ ${json.error || 'Không thể lưu cấu hình hệ thống.'}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const getOffsiteOverrides = (): Record<string, string> => ({
    offsite_provider: settings.offsite_provider || 'NONE',
    offsite_auto_push: settings.offsite_auto_push || 'NONE',
    offsite_keep_count: settings.offsite_keep_count || '12',
    offsite_encryption_passphrase: settings.offsite_encryption_passphrase || '',
    offsite_s3_preset: settings.offsite_s3_preset || 'R2',
    offsite_s3_endpoint: settings.offsite_s3_endpoint || '',
    offsite_s3_region: settings.offsite_s3_region || '',
    offsite_s3_bucket: settings.offsite_s3_bucket || '',
    offsite_s3_prefix: settings.offsite_s3_prefix || '',
    offsite_s3_access_key: settings.offsite_s3_access_key || '',
    offsite_s3_secret_key: settings.offsite_s3_secret_key || '',
    offsite_gdrive_auth_mode: settings.offsite_gdrive_auth_mode || 'OAUTH2',
    offsite_gdrive_folder_id: settings.offsite_gdrive_folder_id || '',
    offsite_gdrive_client_id: settings.offsite_gdrive_client_id || '',
    offsite_gdrive_client_secret: settings.offsite_gdrive_client_secret || '',
    offsite_gdrive_refresh_token: settings.offsite_gdrive_refresh_token || '',
    offsite_gdrive_service_account_json:
      settings.offsite_gdrive_service_account_json || '',
  });

  const handleTestOffsiteConnection = async () => {
    setTestingOffsite(true);
    setOffsiteTestResult(null);
    try {
      const resp = await fetch('/api/offsite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'test_connection',
          overrides: getOffsiteOverrides(),
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok) {
        setOffsiteTestResult({
          ok: false,
          error:
            json.error ||
            'Không thể kết nối tới dịch vụ Đám mây Offsite. Vui lòng kiểm tra lại thông tin xác thực.',
        });
        return;
      }
      setOffsiteTestResult({
        ok: true,
        providerLabel: json.providerLabel,
        detail:
          json.detail || 'Kết nối kho lưu trữ Đám mây Offsite thành công!',
      });
    } catch (err) {
      setOffsiteTestResult({
        ok: false,
        error:
          (err as Error).message ||
          'Lỗi kết nối khi kiểm tra Đám mây Offsite.',
      });
    } finally {
      setTestingOffsite(false);
    }
  };

  const handleStartGdriveOAuth = async () => {
    const clientId = (settings.offsite_gdrive_client_id || '').trim();
    const clientSecret = (settings.offsite_gdrive_client_secret || '').trim();
    if (!clientId || !clientSecret) {
      setOffsiteTestResult({
        ok: false,
        error:
          'Vui lòng nhập đầy đủ Google Client ID và Google Client Secret trước khi đăng nhập lấy Refresh Token.',
      });
      return;
    }

    setConnectingGdriveOAuth(true);
    setOffsiteTestResult(null);
    try {
      // Lưu tạm các thông tin phụ trợ trên biểu mẫu trước khi chuyển hướng trình duyệt sang Google
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      }).catch(() => {});

      const resp = await fetch('/api/offsite/gdrive-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || !json.ok || !json.authUrl) {
        setOffsiteTestResult({
          ok: false,
          error:
            json.error ||
            'Không thể khởi tạo phiên đăng nhập Google OAuth2. Hãy kiểm tra lại Client ID / Client Secret.',
        });
        return;
      }
      window.location.href = String(json.authUrl);
    } catch (err) {
      setOffsiteTestResult({
        ok: false,
        error:
          (err as Error).message || 'Lỗi kết nối khi khởi tạo Google OAuth2.',
      });
    } finally {
      setConnectingGdriveOAuth(false);
    }
  };

  const handleInsertStandardExcludes = () => {
    const existing = (settings.global_exclude_patterns || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...existing, ...STANDARD_WP_EXCLUDES]));
    updateField('global_exclude_patterns', merged.join('\n'));
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

  const handleToggleDigestEnabled = () => {
    setSettings((prev) => {
      const nextEnabled = prev.digest_enabled === 'true' ? 'false' : 'true';
      const nextCron = (prev.digest_cron_time || '').trim() || '0 7 * * *';
      return {
        ...prev,
        digest_enabled: nextEnabled,
        digest_cron_time: nextCron,
      };
    });
  };

  const handleTestMorningDigest = async () => {
    setTestingDigest(true);
    setDigestResult(null);
    setFeedback('');
    try {
      const payloadSettings: Record<string, string> = {
        ...settings,
        digest_enabled: settings.digest_enabled === 'true' ? 'true' : 'false',
        digest_cron_time:
          (settings.digest_cron_time || '').trim() || '0 7 * * *',
      };
      setSettings(payloadSettings);

      const saveResp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: payloadSettings }),
      });
      if (!saveResp.ok) {
        const saveErr = await saveResp.json().catch(() => ({}));
        setDigestResult({
          ok: false,
          message:
            saveErr.error ||
            'Không thể lưu cấu hình Báo cáo Sáng sớm (kiểm tra lại biểu thức Cron).',
        });
        return;
      }

      const resp = await fetch('/api/settings/digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await resp.json().catch(() => ({}));
      const dispatch = json.dispatch || {};
      const tgSent = Boolean(dispatch.telegramSent ?? json.telegramSent);
      const mailSent = Boolean(dispatch.emailSent ?? json.emailSent);
      const errs: string[] = Array.isArray(dispatch.errors)
        ? (dispatch.errors as string[])
        : Array.isArray(json.errors)
        ? (json.errors as string[])
        : [];

      if (!resp.ok || json.ok === false) {
        setDigestResult({
          ok: false,
          message:
            json.error ||
            'Không thể tổng hợp hoặc gửi Báo cáo Sáng sớm lúc này.',
          telegramSent: tgSent,
          emailSent: mailSent,
          errors: errs,
        });
        return;
      }

      const anyDelivered = tgSent || mailSent;
      setDigestResult({
        ok: anyDelivered && errs.length === 0,
        message: anyDelivered
          ? 'Đã tổng hợp & gửi Báo cáo Sáng sớm 24h thành công!'
          : 'Đã tổng hợp Báo cáo 24h nhưng chưa gửi ra kênh ngoài (hãy kiểm tra Telegram Bot Token / Chat ID hoặc SMTP Email phía trên).',
        telegramSent: tgSent,
        emailSent: mailSent,
        errors: errs,
        summary: json.summary as MorningDigestSummary | undefined,
      });
    } catch (err) {
      setDigestResult({
        ok: false,
        message:
          (err as Error).message ||
          'Lỗi kết nối khi kích hoạt gửi thử Báo cáo Sáng sớm.',
      });
    } finally {
      setTestingDigest(false);
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
        const updatedName = String(json.username);
        setAdminUsername(updatedName);
        setNewUsername(updatedName);
        setCurrentUser((prev) =>
          prev ? { ...prev, username: updatedName } : prev
        );
      }
      setCurrentPassword('');
      setNewPassword('');
      setPwdStatus({
        ok: true,
        message:
          json.message ||
          '✅ Đã cập nhật thông tin tài khoản cá nhân thành công!',
      });
    } catch (err) {
      setPwdStatus({
        ok: false,
        message:
          (err as Error).message || 'Lỗi kết nối khi cập nhật tài khoản.',
      });
    } finally {
      setChangingPwd(false);
    }
  };

  // 2FA Handlers
  const handleInit2faSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaLoading(true);
    setTwoFaMessage(null);
    setFreshRecoveryCodes([]);
    try {
      const resp = await fetch('/api/auth/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'setup',
          currentPassword: twoFaSetupPassword,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setTwoFaMessage({
          ok: false,
          text: json.error || 'Không thể khởi tạo Mã QR 2FA.',
        });
        return;
      }
      setSetupData({
        qrSvg: String(json.qrSvg || ''),
        secret: String(json.secret || ''),
      });
      setTwoFaSetupPassword('');
      setTwoFaVerifyCode('');
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handleEnable2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    setTwoFaLoading(true);
    setTwoFaMessage(null);
    try {
      const resp = await fetch('/api/auth/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enable',
          code: twoFaVerifyCode.trim(),
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setTwoFaMessage({
          ok: false,
          text: json.error || 'Mã xác thực 6 chữ số không chính xác.',
        });
        return;
      }
      if (Array.isArray(json.recoveryCodes)) {
        setFreshRecoveryCodes(json.recoveryCodes as string[]);
      }
      setSetupData(null);
      setTwoFaVerifyCode('');
      setTwoFaMessage({
        ok: true,
        text: '✅ Đã kích hoạt Bảo mật 2 lớp (2FA TOTP) thành công!',
      });
      setCurrentUser((prev) => (prev ? { ...prev, totpEnabled: true } : prev));
      await loadTwoFaStatus();
    } finally {
      setTwoFaLoading(false);
    }
  };

  const handleManage2faSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (twoFaManageAction === 'none') return;
    setTwoFaLoading(true);
    setTwoFaMessage(null);
    try {
      const apiAction =
        twoFaManageAction === 'regenerate' ? 'regenerate_recovery' : 'disable';
      const resp = await fetch('/api/auth/2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: apiAction,
          currentPassword: twoFaActionPassword,
          code: twoFaActionCode.trim(),
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setTwoFaMessage({
          ok: false,
          text: json.error || 'Xác thực không hợp lệ. Vui lòng kiểm tra lại.',
        });
        return;
      }

      if (twoFaManageAction === 'regenerate') {
        if (Array.isArray(json.recoveryCodes)) {
          setFreshRecoveryCodes(json.recoveryCodes as string[]);
        }
        setTwoFaMessage({
          ok: true,
          text: '✅ Đã cấp lại 8 Mã khôi phục dự phòng mới (các mã cũ đã bị vô hiệu hóa).',
        });
      } else {
        setFreshRecoveryCodes([]);
        setTwoFaMessage({
          ok: true,
          text: '✅ Đã tắt Bảo mật 2 lớp (2FA) cho tài khoản.',
        });
        setCurrentUser((prev) =>
          prev ? { ...prev, totpEnabled: false } : prev
        );
      }

      setTwoFaManageAction('none');
      setTwoFaActionPassword('');
      setTwoFaActionCode('');
      await loadTwoFaStatus();
    } finally {
      setTwoFaLoading(false);
    }
  };

  // RBAC Handlers (Tab 3)
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingUser(true);
    setRbacFeedback(null);
    try {
      const resp = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: createUserForm.username.trim(),
          password: createUserForm.password,
          role: createUserForm.role,
        }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRbacFeedback({
          ok: false,
          text: json.error || 'Không thể tạo tài khoản người dùng.',
        });
        return;
      }
      setCreateUserForm({ username: '', password: '', role: 'OPERATOR' });
      setRbacFeedback({
        ok: true,
        text: `✅ Đã tạo tài khoản "${json.user?.username || createUserForm.username.trim()}" thành công!`,
      });
      await loadUsers();
    } finally {
      setCreatingUser(false);
    }
  };

  const handleUpdateUserRole = async (user: UserRecord, role: UserRole) => {
    setRbacFeedback(null);
    const resp = await fetch(`/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setRbacFeedback({
        ok: false,
        text: json.error || 'Không thể thay đổi quyền người dùng.',
      });
      return;
    }
    setRbacFeedback({
      ok: true,
      text: `✅ Đã cập nhật vai trò của "${user.username}" thành ${role}.`,
    });
    await loadUsers();
  };

  const handleSubmitResetUserPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPassTarget) return;
    setResettingPass(true);
    setRbacFeedback(null);
    try {
      const payload: Record<string, unknown> = {
        adminPassword: resetAdminPassword,
        ...(twoFaState.enabled
          ? { adminTotpCode: resetAdminTotpCode.trim() }
          : {}),
      };
      if (resetSecurityMode === 'password') {
        payload.password = resetPassValue;
      } else {
        payload.resetTotp = true;
        payload.reset2fa = true;
      }

      const resp = await fetch(`/api/users/${resetPassTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setRbacFeedback({
          ok: false,
          text:
            json.error ||
            (resetSecurityMode === 'password'
              ? 'Đặt lại mật khẩu thất bại.'
              : 'Không thể đặt lại 2FA cho tài khoản này.'),
        });
        return;
      }
      setRbacFeedback({
        ok: true,
        text:
          resetSecurityMode === 'password'
            ? `✅ Đã đặt lại mật khẩu mới cho tài khoản "${resetPassTarget.username}".`
            : `✅ Đã gỡ Bảo mật 2 lớp (2FA) cho tài khoản "${resetPassTarget.username}".`,
      });
      setResetPassTarget(null);
      setResetPassValue('');
      setResetAdminPassword('');
      setResetAdminTotpCode('');
      if (resetSecurityMode === '2fa') {
        await loadUsers();
      }
    } finally {
      setResettingPass(false);
    }
  };

  const openResetSecurityModal = (
    user: UserRecord,
    mode: 'password' | '2fa'
  ) => {
    setResetSecurityMode(mode);
    setResetPassTarget(user);
    setResetPassValue('');
    setResetAdminPassword('');
    setResetAdminTotpCode('');
    setRbacFeedback(null);
  };

  const handleDeleteUser = async (user: UserRecord) => {
    if (
      !confirm(
        `Xóa vĩnh viễn tài khoản người dùng "${user.username}" (${user.role})?`
      )
    ) {
      return;
    }
    setRbacFeedback(null);
    const resp = await fetch(`/api/users/${user.id}`, {
      method: 'DELETE',
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      setRbacFeedback({
        ok: false,
        text: json.error || 'Không thể xóa tài khoản người dùng.',
      });
      return;
    }
    setRbacFeedback({
      ok: true,
      text: `✅ Đã xóa tài khoản "${user.username}".`,
    });
    await loadUsers();
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
    <div className="space-y-5 sm:space-y-6 min-w-0">
      <div className="min-w-0">
        <h2 className="text-base sm:text-lg font-bold text-white flex items-start sm:items-center gap-2">
          <Settings className="w-5 h-5 text-blue-400 shrink-0 mt-0.5 sm:mt-0" />
          <span>
            {isAdmin ? (
              <>
                <span className="sm:hidden">Cấu hình &amp; Cập nhật Hệ thống</span>
                <span className="hidden sm:inline">
                  Cấu hình Hệ thống, Sao lưu Offsite, Bảo mật 2FA, Phân quyền RBAC &amp; Cập nhật
                </span>
              </>
            ) : (
              'Tài khoản Cá nhân & Bảo mật 2 lớp (2FA TOTP)'
            )}
          </span>
        </h2>
        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
          {isAdmin ? (
            <>
              <span className="sm:hidden">
                Quản lý cảnh báo, Btrfs WORM, Sao lưu Offsite 3-2-1, bảo mật 2FA, phân quyền RBAC và cập nhật 1-Click từ GitHub.
              </span>
              <span className="hidden sm:inline">
                Quản lý cấu hình thông báo &amp; Btrfs WORM, Sao lưu Đám mây Offsite chuẩn 3-2-1 (AES-256-GCM), Bộ lọc file toàn cục, Bảo mật 2FA, Phân quyền RBAC và Cập nhật Prebuilt 1-Click từ GitHub (shostwp-byte/nas-sync).
              </span>
            </>
          ) : (
            'Quản lý mật khẩu đăng nhập và thiết lập xác thực 2 lớp (Google Authenticator / Authy) cho tài khoản của bạn.'
          )}
        </p>
      </div>

      {/* Section Tab Bar: 5-column Segmented Icon+Label Bar on Mobile (< sm), Single-Row Pill Bar on Tablet/Desktop (>= sm) */}
      <div
        role="tablist"
        aria-label="Các mục cấu hình và cập nhật hệ thống"
        className="overflow-x-auto no-scrollbar bg-slate-900 border border-slate-800 rounded-2xl p-1 sm:p-1.5 text-xs"
      >
        <div
          className={
            isAdmin
              ? 'grid grid-cols-5 gap-1 min-w-[290px] sm:min-w-0 sm:flex sm:items-center sm:gap-1.5'
              : 'flex items-center gap-1.5'
          }
        >
          {isAdmin && (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'config'}
                onClick={() => {
                  setFeedback('');
                  setActiveTab('config');
                }}
                className={`relative min-h-[54px] sm:min-h-[42px] px-1 sm:px-3.5 py-1.5 sm:py-2 rounded-xl font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 shrink-0 whitespace-nowrap transition-all ${
                  activeTab === 'config'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                <Settings className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="text-[10px] min-[380px]:text-[11px] sm:text-xs leading-tight tracking-tight sm:tracking-normal">
                  <span className="sm:hidden">Cấu hình</span>
                  <span className="hidden sm:inline">Cấu hình Hệ thống</span>
                </span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'backup'}
                onClick={() => {
                  setFeedback('');
                  setActiveTab('backup');
                }}
                className={`relative min-h-[54px] sm:min-h-[42px] px-1 sm:px-3.5 py-1.5 sm:py-2 rounded-xl font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 shrink-0 whitespace-nowrap transition-all ${
                  activeTab === 'backup'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                <Cloud className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="text-[10px] min-[380px]:text-[11px] sm:text-xs leading-tight tracking-tight sm:tracking-normal">
                  Sao lưu
                </span>
                {settings.offsite_provider &&
                  settings.offsite_provider !== 'NONE' && (
                    <>
                      <span
                        aria-hidden="true"
                        className="sm:hidden absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-slate-900"
                      />
                      <span className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-200 border border-emerald-400/30">
                        ON
                      </span>
                    </>
                  )}
              </button>
            </>
          )}

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'account'}
            onClick={() => {
              setFeedback('');
              setActiveTab('account');
            }}
            className={`relative ${
              isAdmin
                ? 'min-h-[54px] sm:min-h-[42px] px-1 sm:px-3.5 py-1.5 sm:py-2 flex-col sm:flex-row gap-1 sm:gap-1.5'
                : 'flex-1 sm:flex-initial min-h-[42px] px-3.5 py-2 flex-row gap-1.5'
            } rounded-xl font-semibold flex items-center justify-center shrink-0 whitespace-nowrap transition-all ${
              activeTab === 'account'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <ShieldCheck className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" />
            {isAdmin ? (
              <span className="text-[10px] min-[380px]:text-[11px] sm:text-xs leading-tight tracking-tight sm:tracking-normal">
                <span className="sm:hidden">Tài khoản</span>
                <span className="hidden sm:inline xl:hidden">
                  Tài khoản &amp; 2FA
                </span>
                <span className="hidden xl:inline">
                  Tài khoản &amp; Bảo mật 2FA
                </span>
              </span>
            ) : (
              <span className="text-xs">Tài khoản &amp; Bảo mật 2FA</span>
            )}
            {twoFaState.enabled && (
              <>
                {isAdmin && (
                  <span
                    aria-hidden="true"
                    className="sm:hidden absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-slate-900"
                  />
                )}
                <span
                  className={`${
                    isAdmin ? 'hidden sm:inline-block' : 'inline-block'
                  } px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-200 border border-emerald-400/30`}
                >
                  ON
                </span>
              </>
            )}
          </button>

          {isAdmin && (
            <>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'rbac'}
                onClick={() => {
                  setFeedback('');
                  setActiveTab('rbac');
                }}
                className={`relative min-h-[54px] sm:min-h-[42px] px-1 sm:px-3.5 py-1.5 sm:py-2 rounded-xl font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 shrink-0 whitespace-nowrap transition-all ${
                  activeTab === 'rbac'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                <Users className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="text-[10px] min-[380px]:text-[11px] sm:text-xs leading-tight tracking-tight sm:tracking-normal">
                  <span className="sm:hidden">Phân quyền</span>
                  <span className="hidden sm:inline xl:hidden">
                    Phân quyền (RBAC)
                  </span>
                  <span className="hidden xl:inline">
                    Phân quyền Người dùng (RBAC)
                  </span>
                </span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'update'}
                onClick={() => {
                  setFeedback('');
                  setActiveTab('update');
                }}
                className={`relative min-h-[54px] sm:min-h-[42px] px-1 sm:px-3.5 py-1.5 sm:py-2 rounded-xl font-semibold flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 shrink-0 whitespace-nowrap transition-all ${
                  activeTab === 'update'
                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
                }`}
              >
                <ArrowUpCircle className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" />
                <span className="text-[10px] min-[380px]:text-[11px] sm:text-xs leading-tight tracking-tight sm:tracking-normal">
                  Cập nhật
                </span>
                {updateInfo?.hasUpdate && (
                  <>
                    <span
                      aria-hidden="true"
                      className="sm:hidden absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-slate-900 animate-pulse"
                    />
                    <span className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-200 border border-amber-400/30 font-mono">
                      v{updateInfo.latestVersion}
                    </span>
                  </>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      {/* =====================================================================
          TAB SAO LƯU: OFFSITE CLOUD 3-2-1 AES-256-GCM (ADMIN ONLY)
         ===================================================================== */}
      {isAdmin && activeTab === 'backup' && (
        <div className="space-y-6">
          {gdriveOAuthBanner && (
            <div
              className={`p-4 rounded-2xl border text-xs sm:text-sm font-semibold flex items-start justify-between gap-3 shadow-lg ${
                gdriveOAuthBanner.ok
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 shadow-emerald-950/30'
                  : 'bg-rose-500/15 border-rose-500/40 text-rose-200 shadow-rose-950/30'
              }`}
            >
              <span className="break-words">{gdriveOAuthBanner.text}</span>
              <button
                type="button"
                onClick={() => setGdriveOAuthBanner(null)}
                aria-label="Đóng thông báo Google Drive"
                className="text-slate-300 hover:text-white shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {feedback && (
            <div
              className={`p-3.5 rounded-xl border text-xs break-words ${
                feedback.startsWith('❌')
                  ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
                  : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
              }`}
            >
              {feedback}
            </div>
          )}

          <form onSubmit={handleSaveSettings} className="space-y-6 text-xs">
            {/* ===============================================================
                OFFSITE CLOUD BACKUP 3-2-1 (GOOGLE DRIVE + S3/R2/B2 + AES-256-GCM)
               =============================================================== */}
            {(() => {
              const offsiteProvider = (settings.offsite_provider ||
                'NONE') as OffsiteProviderType;
              const gdriveAuthMode = (settings.offsite_gdrive_auth_mode ||
                'OAUTH2') as 'OAUTH2' | 'SERVICE_ACCOUNT';
              const s3Preset = (settings.offsite_s3_preset || 'R2') as
                | 'R2'
                | 'B2'
                | 'AWS'
                | 'CUSTOM';
              const gdriveRedirectUri = `${
                appOrigin || 'http://localhost:3000'
              }/api/offsite/gdrive-oauth`;

              const s3EndpointPlaceholder =
                s3Preset === 'R2'
                  ? 'https://<accountid>.r2.cloudflarestorage.com'
                  : s3Preset === 'B2'
                  ? 'https://s3.us-west-004.backblazeb2.com'
                  : s3Preset === 'AWS'
                  ? 'https://s3.ap-southeast-1.amazonaws.com (để trống nếu dùng chuẩn AWS)'
                  : 'https://minio.example.com:9000';

              const s3RegionPlaceholder =
                s3Preset === 'R2'
                  ? 'auto'
                  : s3Preset === 'B2'
                  ? 'us-west-004'
                  : s3Preset === 'AWS'
                  ? 'ap-southeast-1'
                  : 'us-east-1';

              return (
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-5 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                        <Cloud className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5 sm:mt-0" />
                        <span>
                          Sao lưu Đám mây Offsite chuẩn 3-2-1 (Mã hóa Đầu-Cuối
                          AES-256-GCM)
                        </span>
                      </h3>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Đóng gói nén Snapshot trên NAS, mã hóa đầu-cuối Zero-Knowledge{' '}
                        <code className="font-mono text-emerald-300">
                          AES-256-GCM
                        </code>{' '}
                        ngay tại chỗ trước khi tải lên Google Drive hoặc kho S3 /
                        Cloudflare R2 / Backblaze B2 tách biệt vật lý.
                      </p>
                    </div>

                    <span
                      className={`px-2.5 py-1 rounded-full border text-[11px] font-semibold shrink-0 self-start ${
                        offsiteProvider === 'GOOGLE_DRIVE'
                          ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                          : offsiteProvider === 'S3_COMPATIBLE'
                          ? 'bg-amber-500/15 border-amber-500/35 text-amber-300'
                          : 'bg-slate-950 border-slate-800 text-slate-400'
                      }`}
                    >
                      {offsiteProvider === 'GOOGLE_DRIVE'
                        ? '🟢 Đang bật: Google Drive'
                        : offsiteProvider === 'S3_COMPATIBLE'
                        ? '🟠 Đang bật: S3 / R2 / B2'
                        : '🚫 Chỉ lưu tại NAS'}
                    </span>
                  </div>

                  {/* 1. Provider Selector Cards/Pills */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {[
                      {
                        value: 'NONE' as OffsiteProviderType,
                        title: '🚫 Tắt (Chỉ lưu tại NAS)',
                        desc: 'Không đẩy bản sao lưu ra đám mây ngoài NAS.',
                        activeClass:
                          'bg-slate-800/80 border-slate-600 text-white',
                      },
                      {
                        value: 'GOOGLE_DRIVE' as OffsiteProviderType,
                        title:
                          '🟢 Google Drive (Gmail Cá nhân / Google One / Workspace)',
                        desc: 'Tận dụng dung lượng Google One / Workspace sẵn có với OAuth2 hoặc Service Account.',
                        activeClass:
                          'bg-emerald-500/15 border-emerald-500 text-white shadow-lg shadow-emerald-950/30',
                      },
                      {
                        value: 'S3_COMPATIBLE' as OffsiteProviderType,
                        title: '🟠 S3 / Cloudflare R2 / Backblaze B2',
                        desc: 'Kho Object Storage chuẩn S3 tốc độ cao, miễn phí băng thông tải về (Cloudflare R2).',
                        activeClass:
                          'bg-amber-500/15 border-amber-500 text-white shadow-lg shadow-amber-950/30',
                      },
                    ].map((card) => {
                      const active = offsiteProvider === card.value;
                      return (
                        <button
                          key={card.value}
                          type="button"
                          onClick={() => {
                            updateField('offsite_provider', card.value);
                            setOffsiteTestResult(null);
                          }}
                          className={`p-3.5 rounded-xl border text-left space-y-1 transition-all min-w-0 ${
                            active
                              ? card.activeClass
                              : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                          }`}
                        >
                          <div className="font-semibold text-xs break-words">
                            {card.title}
                          </div>
                          <p className="text-[11px] text-slate-400 leading-relaxed break-words">
                            {card.desc}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  {/* 2. Common Encryption & Retention Row (when provider !== 'NONE') */}
                  {offsiteProvider !== 'NONE' && (
                    <div className="space-y-5 pt-2 border-t border-slate-800/80">
                      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                        <div className="lg:col-span-5 flex flex-col justify-between">
                          <label className="block text-slate-300 font-medium mb-1">
                            Mật khẩu Mã hóa Đầu-Cuối AES-256-GCM * (tối thiểu 12 ký
                            tự)
                          </label>
                          <div className="relative">
                            <input
                              type={showOffsitePassphrase ? 'text' : 'password'}
                              minLength={12}
                              autoComplete="new-password"
                              value={settings.offsite_encryption_passphrase || ''}
                              onChange={(e) =>
                                updateField(
                                  'offsite_encryption_passphrase',
                                  e.target.value
                                )
                              }
                              placeholder="Nhập khóa bí mật tối thiểu 12 ký tự..."
                              className="w-full min-h-[42px] bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-lg pl-3 pr-10 py-2 text-white font-mono outline-none"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setShowOffsitePassphrase((v) => !v)
                              }
                              aria-label={
                                showOffsitePassphrase
                                  ? 'Ẩn mật khẩu mã hóa Offsite'
                                  : 'Hiện mật khẩu mã hóa Offsite'
                              }
                              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                            >
                              {showOffsitePassphrase ? (
                                <EyeOff className="w-4 h-4" />
                              ) : (
                                <Eye className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>

                        <div className="lg:col-span-4 flex flex-col justify-between">
                          <label className="block text-slate-300 font-medium mb-1">
                            Chế độ tự động đẩy lên Mây
                          </label>
                          <select
                            value={settings.offsite_auto_push || 'NONE'}
                            onChange={(e) =>
                              updateField('offsite_auto_push', e.target.value)
                            }
                            className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                          >
                            <option value="NONE">Chỉ đẩy thủ công</option>
                            <option value="WEEKLY_SUNDAY">
                              Tự động Chủ Nhật hàng tuần
                            </option>
                            <option value="EVERY_BACKUP">
                              Tự động sau mỗi lần Sao lưu thành công
                            </option>
                          </select>
                        </div>

                        <div className="lg:col-span-3 flex flex-col justify-between">
                          <label className="block text-slate-300 font-medium mb-1">
                            Số bản lưu giữ tối đa trên Mây / mỗi VPS
                          </label>
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={settings.offsite_keep_count || '12'}
                            onChange={(e) =>
                              updateField('offsite_keep_count', e.target.value)
                            }
                            className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                          />
                        </div>
                      </div>

                      {/* Concise Disaster-Recovery Callout */}
                      <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-2">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="font-semibold text-amber-200 flex items-center gap-1.5">
                            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                            <span>
                              Lệnh Giải mã Khẩn cấp Độc lập (Disaster Recovery —
                              khi NAS gặp sự cố vật lý):
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={async () => {
                              await copyTextSafe(EMERGENCY_DECRYPT_CMD);
                              setCopiedDecryptCmd(true);
                              setTimeout(() => setCopiedDecryptCmd(false), 2000);
                            }}
                            className="w-full sm:w-auto justify-center min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-amber-200 border border-amber-500/30 text-[11px] shrink-0"
                          >
                            {copiedDecryptCmd ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                <span>Đã sao chép lệnh!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5" />
                                <span>Sao chép lệnh giải mã</span>
                              </>
                            )}
                          </button>
                        </div>
                        <pre className="p-2.5 rounded-lg bg-slate-950 border border-slate-800 font-mono text-[11px] text-cyan-300 overflow-x-auto whitespace-pre-wrap break-all">
                          {EMERGENCY_DECRYPT_CMD}
                        </pre>
                        <p className="text-[11px] text-amber-100/80">
                          Hãy lưu giữ Mật khẩu Mã hóa AES-256-GCM ở nơi an toàn:
                          không ai (kể cả Google/Cloudflare) có thể đọc file{' '}
                          <code className="font-mono">.tar.gz.enc</code> nếu thiếu
                          mật khẩu này.
                        </p>
                      </div>

                      {/* 3. GOOGLE DRIVE CONFIGURATION */}
                      {offsiteProvider === 'GOOGLE_DRIVE' && (
                        <div className="p-4 rounded-xl bg-slate-950 border border-emerald-500/25 space-y-4">
                          <div className="space-y-2">
                            <label className="block text-slate-300 font-semibold">
                              Phương thức Xác thực Google Drive
                            </label>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                              {[
                                {
                                  key: 'OAUTH2' as const,
                                  label:
                                    'OAuth2 (Tài khoản Gmail Cá nhân / Google One / Workspace)',
                                },
                                {
                                  key: 'SERVICE_ACCOUNT' as const,
                                  label:
                                    'Service Account JSON (Chạy ngầm Workspace / Thư mục chia sẻ)',
                                },
                              ].map((m) => {
                                const active = gdriveAuthMode === m.key;
                                return (
                                  <button
                                    key={m.key}
                                    type="button"
                                    onClick={() =>
                                      updateField(
                                        'offsite_gdrive_auth_mode',
                                        m.key
                                      )
                                    }
                                    className={`min-h-[42px] px-3.5 py-2 rounded-xl border text-left font-medium transition-colors break-words ${
                                      active
                                        ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-200'
                                        : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                                    }`}
                                  >
                                    {m.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div>
                            <label className="block text-slate-300 font-medium mb-1">
                              Google Drive Folder ID (hoặc dán nguyên link thư mục
                              Drive) *
                            </label>
                            <input
                              value={settings.offsite_gdrive_folder_id || ''}
                              onChange={(e) =>
                                updateField(
                                  'offsite_gdrive_folder_id',
                                  e.target.value
                                )
                              }
                              placeholder="VD: 1A2b3C4d5E6f7G8h9I0j... hoặc https://drive.google.com/drive/folders/1A2b3C4d5E..."
                              className="w-full min-h-[42px] bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-3 py-2 text-white font-mono outline-none"
                            />
                          </div>

                          {gdriveAuthMode === 'OAUTH2' ? (
                            <div className="space-y-4 pt-2 border-t border-slate-800/80">
                              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                  <span className="text-[11px] text-slate-300 font-medium">
                                    Authorized Redirect URI (dán vào Google Cloud
                                    Console → OAuth 2.0 Client IDs):
                                  </span>
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await copyTextSafe(gdriveRedirectUri);
                                      setCopiedRedirectUri(true);
                                      setTimeout(
                                        () => setCopiedRedirectUri(false),
                                        2000
                                      );
                                    }}
                                    className="w-full sm:w-auto justify-center min-h-[34px] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-[11px] font-medium shrink-0"
                                  >
                                    {copiedRedirectUri ? (
                                      <>
                                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                                        <span>Đã sao chép Redirect URI!</span>
                                      </>
                                    ) : (
                                      <>
                                        <Copy className="w-3.5 h-3.5" />
                                        <span>Sao chép Redirect URI</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                                <code className="block p-2 rounded bg-slate-950 border border-slate-800 font-mono text-[11px] text-cyan-300 break-all select-all">
                                  {gdriveRedirectUri}
                                </code>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="flex flex-col justify-between">
                                  <label className="block text-slate-400 mb-1">
                                    Google Client ID
                                  </label>
                                  <input
                                    value={
                                      settings.offsite_gdrive_client_id || ''
                                    }
                                    onChange={(e) =>
                                      updateField(
                                        'offsite_gdrive_client_id',
                                        e.target.value
                                      )
                                    }
                                    placeholder="1234567890-abc...apps.googleusercontent.com"
                                    autoComplete="off"
                                    className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                                  />
                                </div>

                                <div className="flex flex-col justify-between">
                                  <label className="block text-slate-400 mb-1">
                                    Google Client Secret
                                  </label>
                                  <div className="relative">
                                    <input
                                      type={
                                        showGdriveClientSecret
                                          ? 'text'
                                          : 'password'
                                      }
                                      value={
                                        settings.offsite_gdrive_client_secret ||
                                        ''
                                      }
                                      onChange={(e) =>
                                        updateField(
                                          'offsite_gdrive_client_secret',
                                          e.target.value
                                        )
                                      }
                                      placeholder="GOCSPX-..."
                                      autoComplete="new-password"
                                      className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowGdriveClientSecret((v) => !v)
                                      }
                                      aria-label={
                                        showGdriveClientSecret
                                          ? 'Ẩn Google Client Secret'
                                          : 'Hiện Google Client Secret'
                                      }
                                      className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                                    >
                                      {showGdriveClientSecret ? (
                                        <EyeOff className="w-4 h-4" />
                                      ) : (
                                        <Eye className="w-4 h-4" />
                                      )}
                                    </button>
                                  </div>
                                </div>
                              </div>

                              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-end">
                                <div className="lg:col-span-5">
                                  <button
                                    type="button"
                                    disabled={connectingGdriveOAuth}
                                    onClick={() => void handleStartGdriveOAuth()}
                                    className="w-full min-h-[42px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold inline-flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 transition-colors"
                                  >
                                    <span>
                                      {connectingGdriveOAuth
                                        ? '⏳ Đang chuyển hướng sang Google...'
                                        : '🔗 Đăng nhập Google & Tự lấy Refresh Token'}
                                    </span>
                                  </button>
                                </div>

                                <div className="lg:col-span-7">
                                  <label className="block text-slate-400 mb-1">
                                    Refresh Token (tự động điền sau khi Đăng nhập
                                    Google hoặc dán thủ công)
                                  </label>
                                  <div className="relative">
                                    <input
                                      type={
                                        showGdriveRefreshToken
                                          ? 'text'
                                          : 'password'
                                      }
                                      value={
                                        settings.offsite_gdrive_refresh_token ||
                                        ''
                                      }
                                      onChange={(e) =>
                                        updateField(
                                          'offsite_gdrive_refresh_token',
                                          e.target.value
                                        )
                                      }
                                      placeholder="1//0g..."
                                      autoComplete="new-password"
                                      className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setShowGdriveRefreshToken((v) => !v)
                                      }
                                      aria-label={
                                        showGdriveRefreshToken
                                          ? 'Ẩn Refresh Token'
                                          : 'Hiện Refresh Token'
                                      }
                                      className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                                    >
                                      {showGdriveRefreshToken ? (
                                        <EyeOff className="w-4 h-4" />
                                      ) : (
                                        <Eye className="w-4 h-4" />
                                      )}
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-3 pt-2 border-t border-slate-800/80">
                              <div>
                                <label className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-300 font-medium mb-1">
                                  <span>Nội dung tệp JSON Service Account</span>
                                  {settings.offsite_gdrive_service_account_json ===
                                    '••••••••' && (
                                    <span className="text-[11px] text-emerald-400 font-normal">
                                      (Đã lưu bảo mật — dán JSON mới nếu muốn thay
                                      thế)
                                    </span>
                                  )}
                                </label>
                                <textarea
                                  rows={5}
                                  value={
                                    settings.offsite_gdrive_service_account_json ||
                                    ''
                                  }
                                  onChange={(e) =>
                                    updateField(
                                      'offsite_gdrive_service_account_json',
                                      e.target.value
                                    )
                                  }
                                  placeholder='{"type": "service_account", "project_id": "...", "private_key": "...", "client_email": "backup-bot@project.iam.gserviceaccount.com"}'
                                  className="w-full bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-xl px-3 py-2 text-white font-mono text-xs outline-none"
                                />
                              </div>
                              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-200 leading-relaxed">
                                💡 <strong>Lưu ý quan trọng:</strong> Hãy mở thư
                                mục Google Drive đích trên trình duyệt và bấm{' '}
                                <strong>Chia sẻ (Share — quyền Người chỉnh sửa / Editor)</strong>{' '}
                                cho địa chỉ{' '}
                                <code className="font-mono text-white">
                                  client_email
                                </code>{' '}
                                nằm bên trong tệp JSON Service Account.
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* 4. S3 / CLOUDFLARE R2 / BACKBLAZE B2 CONFIGURATION */}
                      {offsiteProvider === 'S3_COMPATIBLE' && (
                        <div className="p-4 rounded-xl bg-slate-950 border border-amber-500/25 space-y-4">
                          <div className="space-y-2">
                            <label className="block text-slate-300 font-semibold">
                              Chọn nhanh Nhà cung cấp S3-Compatible
                            </label>
                            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2">
                              {[
                                {
                                  key: 'R2' as const,
                                  label: 'Cloudflare R2',
                                },
                                {
                                  key: 'B2' as const,
                                  label: 'Backblaze B2',
                                },
                                {
                                  key: 'AWS' as const,
                                  label: 'AWS S3',
                                },
                                {
                                  key: 'CUSTOM' as const,
                                  label: 'MinIO / S3 Tùy chỉnh',
                                },
                              ].map((p) => {
                                const active = s3Preset === p.key;
                                return (
                                  <button
                                    key={p.key}
                                    type="button"
                                    onClick={() => {
                                      setSettings((prev) => ({
                                        ...prev,
                                        offsite_s3_preset: p.key,
                                        offsite_s3_region:
                                          p.key === 'R2'
                                            ? 'auto'
                                            : prev.offsite_s3_region === 'auto'
                                            ? ''
                                            : prev.offsite_s3_region || '',
                                      }));
                                    }}
                                    className={`min-h-[38px] px-3 py-1.5 rounded-lg border font-medium text-center justify-center inline-flex items-center transition-colors ${
                                      active
                                        ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
                                        : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'
                                    }`}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="md:col-span-2 flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Endpoint URL
                              </label>
                              <input
                                value={settings.offsite_s3_endpoint || ''}
                                onChange={(e) =>
                                  updateField(
                                    'offsite_s3_endpoint',
                                    e.target.value
                                  )
                                }
                                placeholder={s3EndpointPlaceholder}
                                autoComplete="off"
                                className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                              />
                            </div>

                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Region
                              </label>
                              <input
                                value={
                                  settings.offsite_s3_region ??
                                  (s3Preset === 'R2' ? 'auto' : '')
                                }
                                onChange={(e) =>
                                  updateField(
                                    'offsite_s3_region',
                                    e.target.value
                                  )
                                }
                                placeholder={s3RegionPlaceholder}
                                autoComplete="off"
                                className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Tên Bucket *
                              </label>
                              <input
                                value={settings.offsite_s3_bucket || ''}
                                onChange={(e) =>
                                  updateField(
                                    'offsite_s3_bucket',
                                    e.target.value
                                  )
                                }
                                placeholder="VD: nas-sync-offsite-vault"
                                autoComplete="off"
                                className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                              />
                            </div>

                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Thư mục tiền tố (Prefix)
                              </label>
                              <input
                                value={settings.offsite_s3_prefix || ''}
                                onChange={(e) =>
                                  updateField(
                                    'offsite_s3_prefix',
                                    e.target.value
                                  )
                                }
                                placeholder="nas-sync-backups"
                                autoComplete="off"
                                className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Access Key ID *
                              </label>
                              <input
                                value={settings.offsite_s3_access_key || ''}
                                onChange={(e) =>
                                  updateField(
                                    'offsite_s3_access_key',
                                    e.target.value
                                  )
                                }
                                placeholder="AKIA... / R2 Access Key ID"
                                autoComplete="off"
                                className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                              />
                            </div>

                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Secret Access Key *
                              </label>
                              <div className="relative">
                                <input
                                  type={showS3SecretKey ? 'text' : 'password'}
                                  value={settings.offsite_s3_secret_key || ''}
                                  onChange={(e) =>
                                    updateField(
                                      'offsite_s3_secret_key',
                                      e.target.value
                                    )
                                  }
                                  placeholder="Secret Access Key..."
                                  autoComplete="new-password"
                                  className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowS3SecretKey((v) => !v)}
                                  aria-label={
                                    showS3SecretKey
                                      ? 'Ẩn Secret Access Key'
                                      : 'Hiện Secret Access Key'
                                  }
                                  className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                                >
                                  {showS3SecretKey ? (
                                    <EyeOff className="w-4 h-4" />
                                  ) : (
                                    <Eye className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 5. Test Connection Button & Inline Result */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                        <button
                          type="button"
                          disabled={testingOffsite}
                          onClick={() => void handleTestOffsiteConnection()}
                          className="w-full sm:w-auto justify-center min-h-[42px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/35 font-semibold disabled:opacity-50 transition-colors"
                        >
                          {testingOffsite ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                              <span>Đang kiểm tra kết nối Đám mây...</span>
                            </>
                          ) : (
                            <span>🧪 Kiểm tra Kết nối Đám mây</span>
                          )}
                        </button>

                        <button
                          type="submit"
                          disabled={saving}
                          className="w-full sm:w-auto justify-center min-h-[42px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold shadow-lg shadow-blue-600/20 transition-colors"
                        >
                          <Save className="w-4 h-4 shrink-0" />
                          <span>
                            {saving
                              ? 'Đang lưu...'
                              : 'Lưu Cấu hình Offsite 3-2-1'}
                          </span>
                        </button>
                      </div>

                      {offsiteTestResult && (
                        <div
                          className={`p-3.5 rounded-xl border text-xs break-words space-y-1 ${
                            offsiteTestResult.ok
                              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                              : 'bg-rose-500/15 border-rose-500/40 text-rose-200'
                          }`}
                        >
                          <div className="font-semibold">
                            {offsiteTestResult.ok
                              ? `✅ Kết nối thành công${
                                  offsiteTestResult.providerLabel
                                    ? ` (${offsiteTestResult.providerLabel})`
                                    : ''
                                }!`
                              : '❌ Kiểm tra kết nối Đám mây thất bại'}
                          </div>
                          <div>
                            {offsiteTestResult.ok
                              ? offsiteTestResult.detail
                              : offsiteTestResult.error}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {offsiteProvider === 'NONE' && (
                    <div className="flex justify-end pt-2 border-t border-slate-800/80">
                      <button
                        type="submit"
                        disabled={saving}
                        className="w-full sm:w-auto justify-center min-h-[42px] inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold shadow-lg shadow-blue-600/20 transition-colors"
                      >
                        <Save className="w-4 h-4 shrink-0" />
                        <span>
                          {saving
                            ? 'Đang lưu...'
                            : 'Lưu Cấu hình Offsite 3-2-1'}
                        </span>
                      </button>
                    </div>
                  )}

                  {/* Recent Offsite Transfers History */}
                  {(offsiteProvider !== 'NONE' || offsiteJobs.length > 0) && (
                    <div className="pt-3 border-t border-slate-800 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-xs font-bold text-slate-200">
                          Lịch sử Đồng bộ Offsite Gần đây ({offsiteJobs.length})
                        </h4>
                        <button
                          type="button"
                          onClick={() => void loadOffsiteJobs()}
                          disabled={offsiteJobsLoading}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 inline-flex items-center gap-1.5 transition-colors"
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 shrink-0 ${
                              offsiteJobsLoading ? 'animate-spin' : ''
                            }`}
                          />
                          <span>Làm mới</span>
                        </button>
                      </div>

                      {offsiteJobs.length === 0 ? (
                        <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-center text-slate-500">
                          Chưa có phiên đẩy dữ liệu Offsite 3-2-1 nào. Bạn có thể
                          nhấn <strong>☁️ Đẩy Offsite 3-2-1</strong> tại trang{' '}
                          <strong className="text-slate-300">Tiến trình</strong>{' '}
                          hoặc bật chế độ tự động đẩy.
                        </div>
                      ) : (
                        <div className="border border-slate-800 rounded-xl overflow-hidden">
                          {/* Mobile Offsite Transfer Cards (< md) */}
                          <div className="md:hidden divide-y divide-slate-800 max-h-72 overflow-y-auto">
                            {offsiteJobs.slice(0, 10).map((oj) => {
                              const st = getOffsiteStatusMeta(oj.status);
                              const providerBadge =
                                oj.provider === 'GOOGLE_DRIVE'
                                  ? 'Google Drive'
                                  : 'S3';
                              return (
                                <div
                                  key={oj.id}
                                  className="p-3.5 bg-slate-950/60 space-y-2"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="font-semibold text-white break-all">
                                        {oj.server_hostname ||
                                          `VPS #${oj.server_id}`}
                                      </div>
                                      <div className="font-mono text-[11px] text-cyan-300 break-all">
                                        {oj.snapshot_name}
                                      </div>
                                    </div>
                                    <span
                                      className={`px-2 py-0.5 rounded border text-[10px] font-semibold shrink-0 ${st.className}`}
                                    >
                                      {st.label}
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                                    <span
                                      className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                                        oj.provider === 'GOOGLE_DRIVE'
                                          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                          : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                                      }`}
                                    >
                                      {providerBadge}
                                    </span>
                                    <span className="font-mono text-slate-200">
                                      {oj.encrypted_size_bytes > 0
                                        ? formatBytes(oj.encrypted_size_bytes)
                                        : '—'}{' '}
                                      •{' '}
                                      {oj.duration_seconds > 0
                                        ? formatEta(oj.duration_seconds)
                                        : '—'}
                                    </span>
                                  </div>

                                  {oj.error_message && (
                                    <div className="text-[11px] text-rose-300 break-words">
                                      ❌ {oj.error_message}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {/* Desktop Offsite Transfer Table (>= md) */}
                          <div className="hidden md:block overflow-x-auto max-h-72 overflow-y-auto">
                            <table className="w-full min-w-[680px] text-left text-xs">
                              <thead className="bg-slate-950 text-slate-400 border-b border-slate-800">
                                <tr>
                                  <th className="p-3 font-medium">Máy chủ VPS</th>
                                  <th className="p-3 font-medium">Snapshot</th>
                                  <th className="p-3 font-medium">Đám mây</th>
                                  <th className="p-3 font-medium">
                                    Dung lượng mã hóa
                                  </th>
                                  <th className="p-3 font-medium">Thời lượng</th>
                                  <th className="p-3 font-medium">Trạng thái</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-800/80 bg-slate-950/40">
                                {offsiteJobs.slice(0, 10).map((oj) => {
                                  const st = getOffsiteStatusMeta(oj.status);
                                  const providerBadge =
                                    oj.provider === 'GOOGLE_DRIVE'
                                      ? 'Google Drive'
                                      : 'S3';
                                  return (
                                    <tr
                                      key={oj.id}
                                      className="hover:bg-slate-800/30"
                                    >
                                      <td className="p-3 font-semibold text-white">
                                        <div>
                                          {oj.server_hostname ||
                                            `VPS #${oj.server_id}`}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-normal">
                                          {formatDateTime(
                                            oj.completed_at || oj.created_at
                                          )}
                                        </div>
                                      </td>
                                      <td className="p-3 font-mono text-cyan-300">
                                        <div>{oj.snapshot_name}</div>
                                        {oj.error_message && (
                                          <div className="text-[11px] font-sans text-rose-300 break-words max-w-xs mt-0.5">
                                            ❌ {oj.error_message}
                                          </div>
                                        )}
                                      </td>
                                      <td className="p-3 whitespace-nowrap">
                                        <span
                                          className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${
                                            oj.provider === 'GOOGLE_DRIVE'
                                              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                              : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                                          }`}
                                        >
                                          {providerBadge}
                                        </span>
                                      </td>
                                      <td className="p-3 font-mono text-slate-200 whitespace-nowrap">
                                        {oj.encrypted_size_bytes > 0
                                          ? formatBytes(oj.encrypted_size_bytes)
                                          : '—'}
                                      </td>
                                      <td className="p-3 font-mono text-slate-300 whitespace-nowrap">
                                        {oj.duration_seconds > 0
                                          ? formatEta(oj.duration_seconds)
                                          : '—'}
                                      </td>
                                      <td className="p-3 whitespace-nowrap">
                                        <span
                                          className={`px-2 py-0.5 rounded border text-[11px] font-medium ${st.className}`}
                                        >
                                          {st.label}
                                        </span>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </form>
        </div>
      )}

      {/* =====================================================================
          TAB 1: CẤU HÌNH HỆ THỐNG (ADMIN ONLY)
         ===================================================================== */}
      {isAdmin && activeTab === 'config' && (
        <div className="space-y-6">
          {feedback && (
            <div
              className={`p-3.5 rounded-xl border text-xs break-words ${
                feedback.startsWith('❌')
                  ? 'bg-rose-500/15 border-rose-500/35 text-rose-200'
                  : 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
              }`}
            >
              {feedback}
            </div>
          )}

          <form onSubmit={handleSaveSettings} className="space-y-6 text-xs">
            {/* Row 1: Telegram & SMTP (Left) + Anomaly Detection & Universal OS-Level WORM (Right) */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              {/* Left Column: Telegram & SMTP */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                      <BellRing className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5 sm:mt-0" />
                      <span>Cảnh báo Telegram &amp; Báo cáo SMTP Email</span>
                    </h3>
                    <button
                      type="button"
                      onClick={() => void handleTestNotification()}
                      disabled={testingNotify}
                      className="w-full sm:w-auto justify-center min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 disabled:opacity-50 transition-colors shrink-0"
                    >
                      <Send className="w-3.5 h-3.5 shrink-0" />
                      {testingNotify ? 'Đang gửi...' : 'Gửi Tin nhắn Test'}
                    </button>
                  </div>

                  {notifyStatus && (
                    <div
                      className={`p-3 rounded-xl border text-xs space-y-1.5 break-words ${
                        notifyStatus.ok
                          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                          : 'bg-rose-500/15 border-rose-500/30 text-rose-200'
                      }`}
                    >
                      <div className="font-semibold">
                        {notifyStatus.summary}
                      </div>
                      {notifyStatus.details &&
                        notifyStatus.details.length > 0 && (
                          <ul className="list-disc pl-4 space-y-1 text-[11px] text-rose-100/90">
                            {notifyStatus.details.map((err, i) => (
                              <li key={i}>{err}</li>
                            ))}
                          </ul>
                        )}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-400 mb-1">
                        Telegram Bot Token
                      </label>
                      <div className="relative">
                        <input
                          type={showTelegramToken ? 'text' : 'password'}
                          value={settings.telegram_bot_token || ''}
                          onChange={(e) =>
                            updateField('telegram_bot_token', e.target.value)
                          }
                          placeholder="123456789:AAH..."
                          autoComplete="off"
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTelegramToken((v) => !v)}
                          aria-label={
                            showTelegramToken
                              ? 'Ẩn Telegram Bot Token'
                              : 'Hiện Telegram Bot Token'
                          }
                          className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                        >
                          {showTelegramToken ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-col justify-between">
                      <div className="flex flex-wrap items-center justify-between gap-1.5 mb-1">
                        <label className="text-slate-400">
                          Telegram Chat ID / Group ID
                        </label>
                        <button
                          type="button"
                          onClick={() => void handleDetectTelegramChatId()}
                          disabled={
                            detectingChatId ||
                            (settings.telegram_bot_token || '').trim()
                              .length === 0
                          }
                          className="min-h-[28px] px-2 py-0.5 rounded-md bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 inline-flex items-center gap-1 text-[11px] text-cyan-300 font-medium disabled:opacity-50 transition-colors"
                        >
                          <Search className="w-3 h-3 shrink-0" />
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
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 -mt-1">
                    Mẹo: Nhập <b>Bot Token</b>, mở Telegram nhắn{' '}
                    <code>/start</code> cho con Bot đó (không điền mã số đầu của
                    Token vào Chat ID), rồi bấm <b>Tự lấy Chat ID</b>.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
                    <div className="sm:col-span-2 flex flex-col justify-between">
                      <label className="block text-slate-400 mb-1">
                        SMTP Host
                      </label>
                      <input
                        value={settings.smtp_host || ''}
                        onChange={(e) =>
                          updateField('smtp_host', e.target.value)
                        }
                        placeholder="smtp.gmail.com"
                        autoComplete="off"
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-400 mb-1">
                        SMTP Port
                      </label>
                      <input
                        value={settings.smtp_port || '587'}
                        onChange={(e) =>
                          updateField('smtp_port', e.target.value)
                        }
                        autoComplete="off"
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-400 mb-1">
                        SMTP User
                      </label>
                      <input
                        name="smtp_auth_user"
                        autoComplete="off"
                        value={settings.smtp_user || ''}
                        onChange={(e) =>
                          updateField('smtp_user', e.target.value)
                        }
                        placeholder="alerts@example.com"
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                      />
                    </div>
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-400 mb-1">
                        SMTP Password
                      </label>
                      <div className="relative">
                        <input
                          name="smtp_auth_pass"
                          type={showSmtpPass ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={settings.smtp_pass || ''}
                          onChange={(e) =>
                            updateField('smtp_pass', e.target.value)
                          }
                          placeholder="App Password (16 ký tự)"
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white"
                        />
                        <button
                          type="button"
                          onClick={() => setShowSmtpPass((v) => !v)}
                          aria-label={
                            showSmtpPass
                              ? 'Ẩn mật khẩu SMTP'
                              : 'Hiện mật khẩu SMTP'
                          }
                          className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                        >
                          {showSmtpPass ? (
                            <EyeOff className="w-4 h-4" />
                          ) : (
                            <Eye className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">
                      Email nhận cảnh báo khẩn cấp
                    </label>
                    <input
                      value={settings.alert_email_to || ''}
                      onChange={(e) =>
                        updateField('alert_email_to', e.target.value)
                      }
                      placeholder="admin@example.com"
                      className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                </div>

                {/* Right Column: Anomaly Detection & Universal OS-Level WORM Snapshot */}
                <div className="space-y-6">
                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
                    <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                      <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5 sm:mt-0" />
                      <span>
                        Ngưỡng Phát hiện Sớm Ransomware (Anomaly Detection)
                      </span>
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="flex flex-col justify-between">
                        <label className="block text-slate-400 mb-1">
                          Tỷ lệ file thay đổi tối đa / ngày (%)
                        </label>
                        <input
                          type="number"
                          value={settings.anomaly_max_changed_percent || '50'}
                          onChange={(e) =>
                            updateField(
                              'anomaly_max_changed_percent',
                              e.target.value
                            )
                          }
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                        />
                      </div>
                      <div className="flex flex-col justify-between">
                        <label className="block text-slate-400 mb-1">
                          Dung lượng tăng đột biến tối đa (GB)
                        </label>
                        <input
                          type="number"
                          value={settings.anomaly_max_delta_gb || '10'}
                          onChange={(e) =>
                            updateField('anomaly_max_delta_gb', e.target.value)
                          }
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                        />
                      </div>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Khi vượt ngưỡng, hệ thống gửi cảnh báo Telegram khẩn cấp và
                      tự động khóa (Pin) toàn bộ các bản sao lưu sạch trước đó.
                    </p>
                  </div>

                  <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
                    <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                      <Lock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                      <span>
                        Khóa Bất biến Snapshot Cấp Hệ điều hành (OS-Level WORM)
                      </span>
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="sm:col-span-2 flex flex-col justify-between">
                        <label className="block text-slate-400 mb-1">
                          Nền tảng / Cơ chế khóa WORM
                        </label>
                        <select
                          value={settings.worm_provider || 'NONE'}
                          onChange={(e) =>
                            updateField('worm_provider', e.target.value)
                          }
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                        >
                          <option value="NONE">
                            Mặc định — Khóa GFS Pin nội bộ &amp; Offsite 3-2-1 (Mọi NAS Docker)
                          </option>
                          <option value="TRUENAS_ZFS">
                            TrueNAS SCALE — ZFS Snapshot &amp; Kernel Hold API v2.0
                          </option>
                          <option value="NAS_WEBAPI">
                            NAS Btrfs Share Snapshot WebAPI (Immutable Share Lock)
                          </option>
                          <option value="WEBHOOK">
                            Custom Host Webhook — Ký HMAC-SHA256 (QNAP / Unraid / OMV / Linux)
                          </option>
                        </select>
                      </div>
                      <div className="flex flex-col justify-between">
                        <label className="block text-slate-400 mb-1">
                          Số ngày khóa WORM
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={3650}
                          value={settings.worm_retention_days || '7'}
                          onChange={(e) =>
                            updateField('worm_retention_days', e.target.value)
                          }
                          className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                        />
                      </div>
                    </div>

                    {(settings.worm_provider || 'NONE') === 'NONE' && (
                      <p className="text-[11px] text-slate-400 bg-slate-950/80 border border-slate-800 rounded-xl p-3 leading-relaxed">
                        Tương thích mặc định với <strong className="text-slate-200">100% thiết bị NAS &amp; Docker</strong> (QNAP, TrueNAS, UGREEN, TerraMaster, Asustor, Unraid, OpenMediaVault, Linux Server). Nếu thiết bị NAS của bạn có REST API ZFS / Btrfs hoặc Webhook riêng, hãy chọn cơ chế tương ứng ở trên để kích hoạt thêm lớp khóa bất biến cấp Kernel.
                      </p>
                    )}

                    {(settings.worm_provider || 'NONE') !== 'NONE' && (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="flex flex-col justify-between">
                            <label className="block text-slate-400 mb-1">
                              {settings.worm_provider === 'TRUENAS_ZFS'
                                ? 'TrueNAS SCALE URL'
                                : settings.worm_provider === 'WEBHOOK'
                                ? 'Webhook Endpoint URL'
                                : 'NAS WebAPI URL'}
                            </label>
                            <input
                              value={settings.worm_api_url || ''}
                              onChange={(e) =>
                                updateField('worm_api_url', e.target.value)
                              }
                              placeholder={
                                settings.worm_provider === 'TRUENAS_ZFS'
                                  ? 'https://192.168.1.50'
                                  : settings.worm_provider === 'WEBHOOK'
                                  ? 'https://192.168.1.10:9443/hooks/worm'
                                  : 'https://192.168.1.10:5001'
                              }
                              className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                            />
                          </div>
                          <div className="flex flex-col justify-between">
                            <label className="block text-slate-400 mb-1">
                              {settings.worm_provider === 'TRUENAS_ZFS'
                                ? 'ZFS Datasets (cách nhau dấu phẩy)'
                                : 'Shared Folders / Targets (dấu phẩy)'}
                            </label>
                            <input
                              value={
                                settings.worm_target_shares || 'VPS_Backups'
                              }
                              onChange={(e) =>
                                updateField(
                                  'worm_target_shares',
                                  e.target.value
                                )
                              }
                              placeholder={
                                settings.worm_provider === 'TRUENAS_ZFS'
                                  ? 'tank/vps_backups'
                                  : 'VPS_Backups'
                              }
                              className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                            />
                          </div>
                        </div>

                        {settings.worm_provider === 'TRUENAS_ZFS' && (
                          <div className="flex flex-col justify-between">
                            <label className="block text-slate-400 mb-1">
                              TrueNAS Bearer API Key
                            </label>
                            <div className="relative">
                              <input
                                type={showWormSecret ? 'text' : 'password'}
                                value={settings.worm_api_key || ''}
                                onChange={(e) =>
                                  updateField('worm_api_key', e.target.value)
                                }
                                placeholder="1-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                              />
                              <button
                                type="button"
                                onClick={() => setShowWormSecret((v) => !v)}
                                aria-label={
                                  showWormSecret ? 'Ẩn API Key' : 'Hiện API Key'
                                }
                                className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                              >
                                {showWormSecret ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        )}

                        {settings.worm_provider === 'NAS_WEBAPI' && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Tài khoản Quản trị NAS
                              </label>
                              <input
                                value={settings.worm_username || ''}
                                onChange={(e) =>
                                  updateField('worm_username', e.target.value)
                                }
                                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                              />
                            </div>
                            <div className="flex flex-col justify-between">
                              <label className="block text-slate-400 mb-1">
                                Mật khẩu Quản trị NAS
                              </label>
                              <div className="relative">
                                <input
                                  type={showWormSecret ? 'text' : 'password'}
                                  value={settings.worm_password || ''}
                                  onChange={(e) =>
                                    updateField('worm_password', e.target.value)
                                  }
                                  className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white"
                                />
                                <button
                                  type="button"
                                  onClick={() => setShowWormSecret((v) => !v)}
                                  aria-label={
                                    showWormSecret
                                      ? 'Ẩn mật khẩu NAS'
                                      : 'Hiện mật khẩu NAS'
                                  }
                                  className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                                >
                                  {showWormSecret ? (
                                    <EyeOff className="w-4 h-4" />
                                  ) : (
                                    <Eye className="w-4 h-4" />
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        {settings.worm_provider === 'WEBHOOK' && (
                          <div className="flex flex-col justify-between">
                            <label className="block text-slate-400 mb-1">
                              Khóa ký HMAC-SHA256 (Header X-NasSync-Signature)
                            </label>
                            <div className="relative">
                              <input
                                type={showWormSecret ? 'text' : 'password'}
                                value={settings.worm_webhook_secret || ''}
                                onChange={(e) =>
                                  updateField(
                                    'worm_webhook_secret',
                                    e.target.value
                                  )
                                }
                                placeholder="Chuỗi bí mật xác thực trên Host Agent"
                                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white font-mono"
                              />
                              <button
                                type="button"
                                onClick={() => setShowWormSecret((v) => !v)}
                                aria-label={
                                  showWormSecret
                                    ? 'Ẩn khóa Webhook'
                                    : 'Hiện khóa Webhook'
                                }
                                className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                              >
                                {showWormSecret ? (
                                  <EyeOff className="w-4 h-4" />
                                ) : (
                                  <Eye className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>
                        )}

                        <label className="flex items-start gap-2.5 py-1 text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={
                              settings.worm_auto_enabled === 'true' ||
                              settings.btrfs_auto_enabled === 'true'
                            }
                            onChange={(e) => {
                              const nextVal = e.target.checked
                                ? 'true'
                                : 'false';
                              updateField('worm_auto_enabled', nextVal);
                              updateField('btrfs_auto_enabled', nextVal);
                            }}
                            className="w-4 h-4 mt-0.5 rounded accent-blue-500 shrink-0"
                          />
                          <span className="leading-relaxed">
                            Tự động chụp khóa bất biến WORM Snapshot lúc 06:00 AM
                            hằng ngày
                          </span>
                        </label>
                        <label className="flex items-start gap-2.5 py-1 text-slate-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={settings.worm_tls_insecure === 'true'}
                            onChange={(e) =>
                              updateField(
                                'worm_tls_insecure',
                                e.target.checked ? 'true' : 'false'
                              )
                            }
                            className="w-4 h-4 mt-0.5 rounded accent-amber-500 shrink-0"
                          />
                          <span className="leading-relaxed">
                            Cho phép chứng chỉ HTTPS tự ký (Self-Signed) trên mạng
                            nội bộ LAN (Mặc định tắt — kiểm tra TLS nghiêm ngặt)
                          </span>
                        </label>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Row 2: Daily Morning Digest (Left) + Global Exclude Rules (Right — Horizontal Pair) */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
                {/* Daily Morning Digest Card */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4 flex flex-col justify-between">
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex items-start sm:items-center justify-between gap-2.5">
                        <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2 min-w-0">
                          <CalendarClock className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                          <span>
                            Báo cáo Tổng hợp Sáng sớm (Daily Morning Digest)
                          </span>
                        </h3>

                        {/* Accessible Switch for digest_enabled */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={settings.digest_enabled === 'true'}
                          onClick={handleToggleDigestEnabled}
                          className={`min-h-[36px] px-2.5 sm:px-3 py-1.5 rounded-xl border inline-flex items-center gap-1.5 sm:gap-2 font-semibold transition-all shrink-0 whitespace-nowrap ${
                            settings.digest_enabled === 'true'
                              ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300'
                              : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          <span
                            className={`w-8 h-4 rounded-full relative transition-colors inline-block shrink-0 ${
                              settings.digest_enabled === 'true'
                                ? 'bg-emerald-500'
                                : 'bg-slate-700'
                            }`}
                          >
                            <span
                              className={`w-3 h-3 rounded-full bg-white absolute top-0.5 transition-all ${
                                settings.digest_enabled === 'true'
                                  ? 'left-4'
                                  : 'left-0.5'
                              }`}
                            />
                          </span>
                          <span>
                            {settings.digest_enabled === 'true'
                              ? 'Đang bật'
                              : 'Đang tắt'}
                          </span>
                        </button>
                      </div>

                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Tự động gửi bản tin tổng kết 24 giờ qua (Job thành công/lỗi,
                        dung lượng Delta thực tốn, SQL Verified, sức khỏe Volume
                        NAS &amp; khóa SSH TOFU) qua Telegram &amp; Email mỗi sáng.
                      </p>
                    </div>

                    <div className="space-y-2.5">
                      <label className="block text-slate-400">
                        Khung giờ gửi tự động hàng ngày (Chọn nhanh hoặc nhập biểu thức Cron)
                      </label>
                      <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5">
                        {DIGEST_CRON_PRESETS.map((preset) => {
                          const activeCron =
                            (settings.digest_cron_time || '0 7 * * *').trim() ===
                            preset.cron;
                          return (
                            <button
                              key={preset.cron}
                              type="button"
                              onClick={() =>
                                updateField('digest_cron_time', preset.cron)
                              }
                              className={`min-h-[38px] px-2.5 sm:px-3 py-1.5 rounded-lg border font-mono text-xs font-medium inline-flex items-center justify-center transition-colors ${
                                activeCron
                                  ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                                  : 'bg-slate-950 border-slate-800 text-slate-300 hover:bg-slate-800'
                              }`}
                            >
                              ⏰ {preset.label}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 pt-1">
                        <input
                          value={settings.digest_cron_time ?? '0 7 * * *'}
                          onChange={(e) =>
                            updateField('digest_cron_time', e.target.value)
                          }
                          placeholder="0 7 * * *"
                          aria-label="Biểu thức Cron cho Báo cáo Sáng sớm"
                          className="flex-1 min-w-0 min-h-[42px] bg-slate-950 border border-slate-800 focus:border-cyan-500 rounded-lg px-3 py-2 text-white font-mono outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => void handleTestMorningDigest()}
                          disabled={testingDigest}
                          className="w-full sm:w-auto justify-center min-h-[42px] whitespace-nowrap inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/35 font-semibold disabled:opacity-50 transition-all"
                        >
                          <span>
                            {testingDigest
                              ? '⏳ Đang tổng hợp & gửi...'
                              : '📨 Gửi thử Báo cáo Sáng ngay'}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <p className="text-[11px] text-slate-500">
                      Mặc định: <code>0 7 * * *</code> (07:00 sáng hàng ngày). Nhấn{' '}
                      <strong className="text-slate-300">
                        Lưu Toàn bộ Cấu hình
                      </strong>{' '}
                      ở cuối trang để lưu lịch tự động.
                    </p>

                    {digestResult && (
                      <div
                        className={`p-3.5 rounded-xl border text-xs space-y-2.5 break-words ${
                          digestResult.ok
                            ? 'bg-emerald-500/10 border-emerald-500/35 text-emerald-100'
                            : 'bg-amber-500/10 border-amber-500/35 text-amber-100'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">
                            {digestResult.message}
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                            <span
                              className={`px-2 py-0.5 rounded border font-medium ${
                                digestResult.telegramSent
                                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200'
                                  : 'bg-slate-900/80 border-slate-700 text-slate-300'
                              }`}
                            >
                              Telegram {digestResult.telegramSent ? '✅' : '—'}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded border font-medium ${
                                digestResult.emailSent
                                  ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200'
                                  : 'bg-slate-900/80 border-slate-700 text-slate-300'
                              }`}
                            >
                              Email {digestResult.emailSent ? '✅' : '—'}
                            </span>
                          </div>
                        </div>

                        {digestResult.summary && (
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-800/70 text-[11px]">
                            <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800/80">
                              <div className="text-slate-400">VPS Online</div>
                              <div className="font-mono font-bold text-white mt-0.5">
                                {digestResult.summary.onlineServers}/
                                {digestResult.summary.totalServers}
                              </div>
                              {digestResult.summary.hostKeyMismatchCount > 0 && (
                                <div className="text-[10px] text-rose-300 mt-0.5">
                                  🚨 {digestResult.summary.hostKeyMismatchCount}{' '}
                                  lệch TOFU
                                </div>
                              )}
                            </div>

                            <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800/80">
                              <div className="text-slate-400">Phiên 24h qua</div>
                              <div className="font-mono font-bold text-emerald-300 mt-0.5">
                                {digestResult.summary.jobsSucceeded24h} hoàn tất
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {digestResult.summary.jobsFailed24h} thất bại
                              </div>
                            </div>

                            <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800/80">
                              <div className="text-slate-400">Delta 24h</div>
                              <div className="font-mono font-bold text-cyan-300 mt-0.5">
                                +{formatBytes(digestResult.summary.netDeltaBytes24h)}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                Tiết kiệm{' '}
                                {Number(
                                  digestResult.summary.savingsPercent || 0
                                ).toFixed(1)}
                                %
                              </div>
                            </div>

                            <div className="p-2 rounded-lg bg-slate-950/80 border border-slate-800/80">
                              <div className="text-slate-400">Kiểm định SQL</div>
                              <div className="font-mono font-bold text-emerald-300 mt-0.5">
                                {digestResult.summary.verifiedDbs24h} DB ✅
                              </div>
                              <div className="text-[10px] text-slate-400">
                                {digestResult.summary.anomalies24h} bất thường
                              </div>
                            </div>
                          </div>
                        )}

                        {digestResult.errors && digestResult.errors.length > 0 && (
                          <ul className="list-disc pl-4 space-y-1 text-[11px] text-rose-200 pt-1">
                            {digestResult.errors.map((err, idx) => (
                              <li key={idx}>{err}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Global Exclude Rules Card (Horizontal right neighbor of Daily Morning Digest) */}
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-3.5 flex flex-col">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                      <Filter className="w-4 h-4 text-violet-400 shrink-0 mt-0.5 sm:mt-0" />
                      <span>
                        Bộ lọc Loại trừ File Toàn cục (Global Exclude Rules)
                      </span>
                    </h3>
                    <button
                      type="button"
                      onClick={handleInsertStandardExcludes}
                      className="w-full sm:w-auto justify-center min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/15 hover:bg-violet-500/25 text-violet-300 border border-violet-500/30 font-medium transition-colors"
                    >
                      <span>+ Chèn bộ lọc rác WordPress/Hosting chuẩn</span>
                    </button>
                  </div>

                  <textarea
                    rows={5}
                    value={settings.global_exclude_patterns || ''}
                    onChange={(e) =>
                      updateField('global_exclude_patterns', e.target.value)
                    }
                    placeholder={STANDARD_WP_EXCLUDES.join('\n')}
                    className="w-full flex-1 min-h-[120px] bg-slate-950 border border-slate-800 focus:border-blue-500 rounded-xl px-3.5 py-2.5 text-white font-mono text-xs outline-none leading-relaxed"
                  />
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Mỗi dòng 1 mẫu đường dẫn chuẩn Rsync{' '}
                    <code>--exclude</code>. Áp dụng tự động cho toàn bộ VPS (và
                    gộp chung với mẫu loại trừ riêng của từng VPS). Nhấn{' '}
                    <strong className="text-slate-300">
                      Lưu Toàn bộ Cấu hình
                    </strong>{' '}
                    để áp dụng.
                  </p>
                </div>
              </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="w-full sm:w-auto justify-center min-h-[44px] inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-sm shadow-lg shadow-blue-600/20 transition-all"
              >
                <Save className="w-4 h-4 shrink-0" />
                {saving ? 'Đang lưu...' : 'Lưu Toàn bộ Cấu hình'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* =====================================================================
          TAB 2: TÀI KHOẢN CÁ NHÂN & BẢO MẬT 2 LỚP (2FA TOTP) — ALL ROLES
         ===================================================================== */}
      {activeTab === 'account' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 text-xs">
          {/* Personal Password & Username Card */}
          <form
            onSubmit={handleChangePassword}
            className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4 h-fit"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-400 shrink-0" />
                <span>Đổi Username / Mật khẩu Cá nhân</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowPasswords((v) => !v)}
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800/70 inline-flex items-center gap-1 text-[11px] text-slate-300 hover:text-white shrink-0"
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
                className={`p-3 rounded-xl border text-xs break-words ${
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
                placeholder="VD: sysadmin"
                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
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
                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
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
                className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
              />
            </div>
            <button
              type="submit"
              disabled={changingPwd}
              className="w-full justify-center min-h-[42px] inline-flex items-center px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white font-semibold border border-slate-700 transition-colors"
            >
              {changingPwd
                ? 'Đang cập nhật...'
                : 'Cập nhật Thông tin Đăng nhập'}
            </button>
          </form>

          {/* 2FA TOTP Google Authenticator Card */}
          <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4 h-fit">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    Bảo mật 2 lớp (2FA TOTP — Google Authenticator / Authy)
                  </span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                  Bảo vệ tài khoản trước nguy cơ lộ mật khẩu bằng mã OTP 6 chữ
                  số đổi mới mỗi 30 giây và 8 Mã khôi phục dự phòng một lần.
                </p>
              </div>
              {twoFaState.enabled ? (
                <span className="self-start shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 font-semibold text-[11px]">
                  <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                  Đã kích hoạt Bảo mật 2 lớp (2FA)
                </span>
              ) : (
                <span className="self-start shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-slate-400 font-medium text-[11px]">
                  Chưa kích hoạt 2FA
                </span>
              )}
            </div>

            {twoFaMessage && (
              <div
                className={`p-3 rounded-xl border text-xs break-words ${
                  twoFaMessage.ok
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                    : 'bg-rose-500/15 border-rose-500/30 text-rose-200'
                }`}
              >
                {twoFaMessage.text}
              </div>
            )}

            {/* Prominent 8 Recovery Codes Box (shown immediately upon enable or regenerate) */}
            {freshRecoveryCodes.length > 0 && (
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="font-bold text-amber-300 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 shrink-0" />
                    <span>
                      Lưu ngay 8 Mã khôi phục dự phòng (Chỉ hiển thị 1 lần duy
                      nhất!)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await copyTextSafe(freshRecoveryCodes.join('\n'));
                      setCopiedRecovery(true);
                      setTimeout(() => setCopiedRecovery(false), 2500);
                    }}
                    className="w-full sm:w-auto justify-center min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-semibold transition-colors shrink-0"
                  >
                    {copiedRecovery ? (
                      <>
                        <Check className="w-3.5 h-3.5 shrink-0" />
                        <span>Đã sao chép 8 mã!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                        <span>Sao chép 8 Mã khôi phục</span>
                      </>
                    )}
                  </button>
                </div>

                <p className="text-[11px] text-amber-100/90 leading-relaxed">
                  Mỗi mã khôi phục chỉ dùng được <strong>1 lần</strong> khi bạn
                  mất điện thoại hoặc đổi thiết bị Authenticator. Hãy lưu vào
                  trình quản lý mật khẩu an toàn.
                </p>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {freshRecoveryCodes.map((code) => (
                    <div
                      key={code}
                      className="px-2 py-2 rounded-lg bg-slate-950 border border-amber-500/30 text-center font-mono text-[11px] sm:text-xs font-bold text-amber-200 tracking-wider select-all"
                    >
                      {code}
                    </div>
                  ))}
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setFreshRecoveryCodes([])}
                    className="min-h-[34px] px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px]"
                  >
                    Tôi đã lưu an toàn, đóng bảng mã
                  </button>
                </div>
              </div>
            )}

            {!twoFaState.enabled ? (
              !setupData ? (
                <form
                  onSubmit={handleInit2faSetup}
                  className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3"
                >
                  <div>
                    <label className="block text-slate-300 font-medium mb-1">
                      Nhập mật khẩu hiện tại để tạo khóa bí mật 2FA TOTP
                    </label>
                    <input
                      type="password"
                      required
                      value={twoFaSetupPassword}
                      onChange={(e) => setTwoFaSetupPassword(e.target.value)}
                      placeholder="Mật khẩu đăng nhập hiện tại..."
                      className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={twoFaLoading || !twoFaSetupPassword}
                    className="w-full sm:w-auto justify-center min-h-[42px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold shadow-lg shadow-emerald-600/20 transition-colors"
                  >
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>
                      {twoFaLoading ? 'Đang khởi tạo...' : 'Khởi tạo Mã QR 2FA'}
                    </span>
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={handleEnable2fa}
                  className="p-4 rounded-xl bg-slate-950 border border-blue-500/30 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    <img
                      src={`data:image/svg+xml;utf8,${encodeURIComponent(
                        setupData.qrSvg
                      )}`}
                      alt="Mã QR thiết lập 2FA TOTP"
                      className="w-44 h-44 sm:w-48 sm:h-48 rounded-xl bg-white p-2 shrink-0"
                    />
                    <div className="space-y-2.5 min-w-0 w-full">
                      <div className="font-semibold text-white">
                        Bước 1: Quét mã QR bằng Google Authenticator, Authy hoặc
                        1Password
                      </div>
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        Nếu bạn đang thao tác trực tiếp trên điện thoại, hãy sao
                        chép Khóa bí mật (Secret Key) dưới đây và dán vào ứng
                        dụng Authenticator:
                      </p>
                      <div className="flex items-center gap-2 p-2.5 rounded-lg bg-slate-900 border border-slate-800">
                        <code className="font-mono text-cyan-300 break-all flex-1 select-all">
                          {setupData.secret}
                        </code>
                        <button
                          type="button"
                          onClick={async () => {
                            await copyTextSafe(setupData.secret);
                            setCopiedSecret(true);
                            setTimeout(() => setCopiedSecret(false), 2000);
                          }}
                          className="min-h-[34px] px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 inline-flex items-center gap-1 shrink-0"
                        >
                          {copiedSecret ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Đã chép</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>Sao chép</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-800 space-y-3">
                    <div>
                      <label className="block text-slate-300 font-medium mb-1">
                        Bước 2: Nhập mã xác thực 6 chữ số hiển thị trên ứng dụng
                      </label>
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={8}
                        required
                        value={twoFaVerifyCode}
                        onChange={(e) => setTwoFaVerifyCode(e.target.value)}
                        placeholder="VD: 123456"
                        className="w-full sm:max-w-xs min-h-[44px] bg-slate-900 border border-slate-700 focus:border-emerald-500 rounded-lg px-3.5 py-2 font-mono text-base tracking-widest text-white outline-none"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="submit"
                        disabled={twoFaLoading || !twoFaVerifyCode.trim()}
                        className="flex-1 sm:flex-initial justify-center min-h-[42px] inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold shadow-lg shadow-emerald-600/20 transition-colors"
                      >
                        <ShieldCheck className="w-4 h-4 shrink-0" />
                        <span>
                          {twoFaLoading ? 'Đang xác nhận...' : 'Kích hoạt 2FA'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSetupData(null);
                          setTwoFaVerifyCode('');
                        }}
                        className="min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        Hủy
                      </button>
                    </div>
                  </div>
                </form>
              )
            ) : (
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="text-slate-200 font-semibold">
                      Trạng thái Mã khôi phục dự phòng (Recovery Codes)
                    </div>
                    <div className="text-[11px] text-slate-400">
                      Còn lại{' '}
                      <strong
                        className={
                          twoFaState.recoveryCodesRemaining <= 2
                            ? 'text-amber-300'
                            : 'text-emerald-300'
                        }
                      >
                        {twoFaState.recoveryCodesRemaining}
                      </strong>{' '}
                      mã khôi phục khả dụng.
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                    <button
                      type="button"
                      onClick={() => {
                        setTwoFaManageAction((prev) =>
                          prev === 'regenerate' ? 'none' : 'regenerate'
                        );
                        setTwoFaActionPassword('');
                        setTwoFaActionCode('');
                      }}
                      className={`min-h-[38px] px-3 py-1.5 rounded-lg border font-medium text-center justify-center inline-flex items-center transition-colors ${
                        twoFaManageAction === 'regenerate'
                          ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-200'
                          : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'
                      }`}
                    >
                      Cấp lại 8 Mã khôi phục mới
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTwoFaManageAction((prev) =>
                          prev === 'disable' ? 'none' : 'disable'
                        );
                        setTwoFaActionPassword('');
                        setTwoFaActionCode('');
                      }}
                      className={`min-h-[38px] px-3 py-1.5 rounded-lg border font-medium text-center justify-center inline-flex items-center transition-colors ${
                        twoFaManageAction === 'disable'
                          ? 'bg-rose-600 text-white border-rose-500'
                          : 'bg-rose-600/15 hover:bg-rose-600/25 border-rose-500/30 text-rose-300'
                      }`}
                    >
                      Tắt 2FA
                    </button>
                  </div>
                </div>

                {twoFaManageAction !== 'none' && (
                  <form
                    onSubmit={handleManage2faSubmit}
                    className="pt-3 border-t border-slate-800 space-y-3"
                  >
                    <div className="font-semibold text-white">
                      {twoFaManageAction === 'regenerate'
                        ? 'Xác nhận cấp mới 8 Mã khôi phục dự phòng (vô hiệu hóa các mã cũ)'
                        : 'Xác nhận tắt Bảo mật 2 lớp (2FA) cho tài khoản'}
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-400 mb-1">
                          Mật khẩu hiện tại
                        </label>
                        <input
                          type="password"
                          required
                          value={twoFaActionPassword}
                          onChange={(e) =>
                            setTwoFaActionPassword(e.target.value)
                          }
                          placeholder="Mật khẩu hiện tại..."
                          className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
                        />
                      </div>
                      <div>
                        <label className="block text-slate-400 mb-1">
                          Mã 2FA 6 chữ số (hoặc Mã khôi phục)
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={16}
                          value={twoFaActionCode}
                          onChange={(e) => setTwoFaActionCode(e.target.value)}
                          placeholder="123456 / XXXX-XXXX"
                          className="w-full min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="submit"
                        disabled={
                          twoFaLoading ||
                          !twoFaActionPassword ||
                          !twoFaActionCode.trim()
                        }
                        className={`flex-1 sm:flex-initial justify-center min-h-[42px] inline-flex items-center px-4 py-2 rounded-lg font-semibold text-white disabled:opacity-50 transition-colors ${
                          twoFaManageAction === 'disable'
                            ? 'bg-rose-600 hover:bg-rose-500'
                            : 'bg-blue-600 hover:bg-blue-500'
                        }`}
                      >
                        {twoFaLoading
                          ? 'Đang xử lý...'
                          : twoFaManageAction === 'regenerate'
                          ? 'Xác nhận Cấp lại 8 Mã mới'
                          : 'Xác nhận Tắt 2FA'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setTwoFaManageAction('none')}
                        className="min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                      >
                        Hủy
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 3: PHÂN QUYỀN NGƯỜI DÙNG (RBAC) — ADMIN ONLY
         ===================================================================== */}
      {isAdmin && activeTab === 'rbac' && (
        <div className="space-y-6 text-xs">
          {rbacFeedback && (
            <div
              className={`p-3.5 rounded-xl border break-words ${
                rbacFeedback.ok
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
                  : 'bg-rose-500/15 border-rose-500/30 text-rose-200'
              }`}
            >
              {rbacFeedback.text}
            </div>
          )}

          {/* Create New User Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
            <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
              <UserPlus className="w-4 h-4 text-blue-400 shrink-0 mt-0.5 sm:mt-0" />
              <span>Tạo Tài khoản Vận hành / Giám sát Mới (RBAC)</span>
            </h3>

            <form
              onSubmit={handleCreateUser}
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end"
            >
              <div>
                <label className="block text-slate-400 mb-1">
                  Tên đăng nhập (Username) *
                </label>
                <input
                  type="text"
                  required
                  minLength={3}
                  maxLength={32}
                  value={createUserForm.username}
                  onChange={(e) =>
                    setCreateUserForm({
                      ...createUserForm,
                      username: e.target.value,
                    })
                  }
                  placeholder="VD: noc_operator"
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Mật khẩu khởi tạo *
                </label>
                <div className="relative">
                  <input
                    type={showNewUserPass ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={createUserForm.password}
                    onChange={(e) =>
                      setCreateUserForm({
                        ...createUserForm,
                        password: e.target.value,
                      })
                    }
                    placeholder="Tối thiểu 8 ký tự..."
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg pl-3 pr-10 py-2 text-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewUserPass((v) => !v)}
                    aria-label="Hiện hoặc ẩn mật khẩu"
                    className="h-9 w-9 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-white absolute right-1 top-1/2 -translate-y-1/2"
                  >
                    {showNewUserPass ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Vai trò Phân quyền (Role) *
                </label>
                <select
                  value={createUserForm.role}
                  onChange={(e) =>
                    setCreateUserForm({
                      ...createUserForm,
                      role: e.target.value as UserRole,
                    })
                  }
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white"
                >
                  <option value="ADMIN">ADMIN — Quản trị toàn quyền</option>
                  <option value="OPERATOR">OPERATOR — Kỹ thuật vận hành</option>
                  <option value="VIEWER">VIEWER — Giám sát NOC (Chỉ xem)</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={creatingUser}
                className="w-full min-h-[42px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold shadow-lg shadow-blue-600/20 transition-colors"
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span>{creatingUser ? 'Đang tạo...' : 'Tạo Tài khoản'}</span>
              </button>
            </form>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5 pt-2 text-[11px]">
              <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                <span className="font-bold text-emerald-300">ADMIN:</span>{' '}
                <span className="text-slate-400">
                  Toàn quyền hệ thống, VPS, SSH Keys, Xóa Snapshot, Cập nhật &amp;
                  Phân quyền.
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                <span className="font-bold text-cyan-300">OPERATOR:</span>{' '}
                <span className="text-slate-400">
                  Sao lưu, Quét thử, Khôi phục, Xem &amp; Tải file — không được
                  xóa/cấu hình.
                </span>
              </div>
              <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800">
                <span className="font-bold text-slate-300">VIEWER:</span>{' '}
                <span className="text-slate-400">
                  Chỉ xem giám sát NOC &amp; lịch sử tiến trình (Read-Only).
                </span>
              </div>
            </div>
          </div>

          {/* Users List Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2 min-w-0">
                <Users className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5 sm:mt-0" />
                <span>Danh sách Tài khoản Hệ thống ({usersList.length})</span>
              </h3>
              <button
                type="button"
                onClick={() => void loadUsers()}
                disabled={usersLoading}
                className="min-h-[36px] shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 shrink-0 ${
                    usersLoading ? 'animate-spin' : ''
                  }`}
                />
                <span>Làm mới</span>
              </button>
            </div>

            {/* Mobile Cards (< md) */}
            <div className="md:hidden divide-y divide-slate-800">
              {usersLoading ? (
                <div className="p-6 text-center text-slate-500">
                  Đang tải danh sách người dùng...
                </div>
              ) : usersList.length === 0 ? (
                <div className="p-6 text-center text-slate-500">
                  Chưa có tài khoản nào.
                </div>
              ) : (
                usersList.map((u) => {
                  const isSelf = u.id === currentUser?.userId;
                  return (
                    <div key={u.id} className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-bold text-sm text-white font-mono flex items-center gap-1.5 flex-wrap">
                            <span className="break-all">{u.username}</span>
                            {isSelf && (
                              <span className="text-[10px] font-sans px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                Bạn
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Đăng nhập cuối:{' '}
                            {u.last_login_at
                              ? formatDateTime(u.last_login_at)
                              : 'Chưa đăng nhập'}
                          </div>
                        </div>

                        {u.totp_enabled === 1 ? (
                          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold shrink-0">
                            2FA ON
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700 text-[10px] shrink-0">
                            2FA OFF
                          </span>
                        )}
                      </div>

                      <div>
                        <label className="block text-[11px] text-slate-400 mb-1">
                          Vai trò (Role):
                        </label>
                        <select
                          value={u.role}
                          disabled={isSelf}
                          onChange={(e) =>
                            void handleUpdateUserRole(
                              u,
                              e.target.value as UserRole
                            )
                          }
                          className="w-full min-h-[38px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-white disabled:opacity-60"
                        >
                          <option value="ADMIN">ADMIN</option>
                          <option value="OPERATOR">OPERATOR</option>
                          <option value="VIEWER">VIEWER</option>
                        </select>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => openResetSecurityModal(u, 'password')}
                            className="flex-1 min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 inline-flex items-center justify-center text-center whitespace-nowrap"
                          >
                            Đặt lại mật khẩu
                          </button>
                        )}
                        {!isSelf && u.totp_enabled === 1 && (
                          <button
                            type="button"
                            onClick={() => openResetSecurityModal(u, '2fa')}
                            className="flex-1 min-h-[38px] px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 inline-flex items-center justify-center text-center whitespace-nowrap"
                          >
                            Reset 2FA
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isSelf}
                          onClick={() => void handleDeleteUser(u)}
                          aria-label={`Xóa người dùng ${u.username}`}
                          className="min-h-[38px] min-w-[38px] p-2 inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 border border-slate-700 disabled:opacity-40 shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Desktop Table (>= md) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-xs">
                <thead className="bg-slate-950/70 text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="p-3.5 font-medium">Tài khoản</th>
                    <th className="p-3.5 font-medium">Vai trò (Role)</th>
                    <th className="p-3.5 font-medium">Bảo mật 2FA</th>
                    <th className="p-3.5 font-medium">Đăng nhập gần nhất</th>
                    <th className="p-3.5 font-medium text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {usersLoading ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-slate-500">
                        Đang tải danh sách người dùng...
                      </td>
                    </tr>
                  ) : usersList.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-8 text-center text-slate-500">
                        Chưa có tài khoản nào.
                      </td>
                    </tr>
                  ) : (
                    usersList.map((u) => {
                      const isSelf = u.id === currentUser?.userId;
                      return (
                        <tr key={u.id} className="hover:bg-slate-800/30">
                          <td className="p-3.5">
                            <div className="font-bold text-white font-mono flex items-center gap-1.5">
                              <span>{u.username}</span>
                              {isSelf && (
                                <span className="text-[10px] font-sans px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                  Bạn
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              Tạo lúc: {formatDateTime(u.created_at)}
                            </div>
                          </td>
                          <td className="p-3.5">
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-2 py-0.5 rounded border text-[10px] font-bold ${getRoleBadgeClass(
                                  u.role
                                )}`}
                              >
                                {u.role}
                              </span>
                              <select
                                value={u.role}
                                disabled={isSelf}
                                onChange={(e) =>
                                  void handleUpdateUserRole(
                                    u,
                                    e.target.value as UserRole
                                  )
                                }
                                className="min-h-[34px] bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1 text-white disabled:opacity-50"
                              >
                                <option value="ADMIN">ADMIN</option>
                                <option value="OPERATOR">OPERATOR</option>
                                <option value="VIEWER">VIEWER</option>
                              </select>
                            </div>
                          </td>
                          <td className="p-3.5">
                            {u.totp_enabled === 1 ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-medium">
                                <ShieldCheck className="w-3 h-3" /> 2FA Đang bật
                              </span>
                            ) : (
                              <span className="text-slate-500">Chưa bật</span>
                            )}
                          </td>
                          <td className="p-3.5 text-slate-300">
                            {u.last_login_at
                              ? formatDateTime(u.last_login_at)
                              : 'Chưa đăng nhập'}
                          </td>
                          <td className="p-3.5 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    openResetSecurityModal(u, 'password')
                                  }
                                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                                >
                                  Đặt lại MK
                                </button>
                              )}
                              {!isSelf && u.totp_enabled === 1 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    openResetSecurityModal(u, '2fa')
                                  }
                                  className="px-2.5 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30"
                                >
                                  Reset 2FA
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isSelf}
                                onClick={() => void handleDeleteUser(u)}
                                title={
                                  isSelf
                                    ? 'Không thể tự xóa tài khoản đang đăng nhập'
                                    : `Xóa tài khoản ${u.username}`
                                }
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 disabled:opacity-40"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Reset User Password / 2FA Re-Auth Modal */}
          {resetPassTarget && (
            <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-4 sm:p-6 space-y-4 max-h-[calc(100dvh-2rem)] overflow-y-auto">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-bold text-white break-words">
                    {resetSecurityMode === 'password'
                      ? 'Đặt lại mật khẩu cho '
                      : 'Xác nhận gỡ Bảo mật 2FA cho '}
                    <span className="text-cyan-300 font-mono">
                      {resetPassTarget.username}
                    </span>
                  </h4>
                  <button
                    type="button"
                    onClick={() => setResetPassTarget(null)}
                    aria-label="Đóng"
                    className="h-9 w-9 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form
                  onSubmit={handleSubmitResetUserPassword}
                  className="space-y-4 text-xs"
                >
                  {resetSecurityMode === 'password' && (
                    <div>
                      <label className="block text-slate-300 mb-1">
                        Mật khẩu mới cho {resetPassTarget.username} (tối thiểu 8 ký tự) *
                      </label>
                      <input
                        type="text"
                        required
                        minLength={8}
                        autoFocus
                        value={resetPassValue}
                        onChange={(e) => setResetPassValue(e.target.value)}
                        placeholder="Nhập mật khẩu mới..."
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-slate-300 mb-1">
                      Mật khẩu Quản trị viên (ADMIN) hiện tại của bạn *
                    </label>
                    <input
                      type="password"
                      required
                      autoComplete="current-password"
                      value={resetAdminPassword}
                      onChange={(e) => setResetAdminPassword(e.target.value)}
                      placeholder="Xác thực mật khẩu ADMIN của bạn..."
                      className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                    />
                  </div>

                  {twoFaState.enabled && (
                    <div>
                      <label className="block text-slate-300 mb-1">
                        Mã 2FA 6 chữ số (hoặc Mã khôi phục) của bạn *
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={16}
                        autoComplete="one-time-code"
                        value={resetAdminTotpCode}
                        onChange={(e) => setResetAdminTotpCode(e.target.value)}
                        placeholder="123456 / XXXX-XXXX"
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  )}

                  <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setResetPassTarget(null)}
                      className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                    >
                      Hủy
                    </button>
                    <button
                      type="submit"
                      disabled={
                        resettingPass ||
                        !resetAdminPassword ||
                        (twoFaState.enabled && !resetAdminTotpCode.trim()) ||
                        (resetSecurityMode === 'password' &&
                          resetPassValue.length < 8)
                      }
                      className={`min-h-[40px] px-4 py-2 rounded-lg disabled:opacity-50 text-white font-semibold ${
                        resetSecurityMode === '2fa'
                          ? 'bg-amber-600 hover:bg-amber-500'
                          : 'bg-blue-600 hover:bg-blue-500'
                      }`}
                    >
                      {resettingPass
                        ? 'Đang xử lý...'
                        : resetSecurityMode === 'password'
                        ? 'Lưu Mật khẩu Mới'
                        : 'Xác nhận Gỡ 2FA'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB CẬP NHẬT: 1-CLICK GITHUB SELF-UPDATE — ADMIN ONLY
         ===================================================================== */}
      {isAdmin && activeTab === 'update' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4 text-xs">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold text-white flex items-start sm:items-center gap-2">
                  <GitBranch className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                  <span>
                    Cập nhật Hệ thống Trực tiếp từ GitHub (1-Click Self-Update)
                  </span>
                </h3>
                {updateInfo?.prebuiltAvailable && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                    ⚡ Hỗ trợ gói Prebuilt SHA-256 (Cập nhật ~5 giây)
                  </span>
                )}
              </div>
              <p className="text-slate-400 flex items-center gap-1.5 flex-wrap">
                <span>Kho mã nguồn chính thức:</span>
                <a
                  href={
                    updateInfo?.repoUrl ||
                    'https://github.com/shostwp-byte/nas-sync'
                  }
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-400 hover:underline inline-flex items-center gap-1 font-mono break-all"
                >
                  github.com/shostwp-byte/nas-sync
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
                <span className="text-slate-500">
                  • Giấy phép MIT (Miễn phí 100%)
                </span>
              </p>
            </div>

            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 w-full xl:w-auto shrink-0">
              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => void handleCheckUpdate()}
                  disabled={checkingUpdate || isUpdatingNow}
                  className="flex-1 sm:flex-initial justify-center min-h-[42px] whitespace-nowrap inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 shrink-0 ${
                      checkingUpdate ? 'animate-spin' : ''
                    }`}
                  />
                  <span>
                    {checkingUpdate ? 'Đang kiểm tra...' : 'Kiểm tra bản mới'}
                  </span>
                </button>

                {updateInfo?.canRollback && (
                  <button
                    type="button"
                    onClick={() => void handleStartRollback()}
                    disabled={isUpdatingNow || !updateInfo.canUpdateNow}
                    className="flex-1 sm:flex-initial justify-center min-h-[42px] whitespace-nowrap inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-500/15 hover:bg-amber-500 text-amber-300 hover:text-slate-950 border border-amber-500/40 font-semibold disabled:opacity-50 transition-colors"
                  >
                    <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                    <span>Quay lại v{updateInfo.rollbackVersion || 'trước'}</span>
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleStartGitHubUpdate()}
                disabled={
                  isUpdatingNow ||
                  (updateInfo !== null && !updateInfo.canUpdateNow)
                }
                className={`w-full sm:w-auto justify-center min-h-[42px] inline-flex items-center gap-1.5 px-4 py-2 rounded-lg font-semibold transition-all disabled:opacity-50 ${
                  updateInfo?.hasUpdate
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                    : 'bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30'
                }`}
              >
                <ArrowUpCircle className="w-4 h-4 shrink-0" />
                <span>
                  {isUpdatingNow
                    ? 'Đang xử lý...'
                    : updateInfo?.hasUpdate
                    ? `Cập nhật ngay lên v${updateInfo.latestVersion}`
                    : 'Cài lại bản Release đã ký'}
                </span>
              </button>
            </div>
          </div>

          {updateInfo && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 sm:gap-4 pt-2">
              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-400">
                  Phiên bản đang chạy trên NAS
                </div>
                <div className="text-sm font-bold text-white mt-1 font-mono flex flex-wrap items-center gap-2">
                  <span>v{updateInfo.currentVersion}</span>
                  {updateInfo.currentCommit && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                      #{updateInfo.currentCommit}
                    </span>
                  )}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800">
                <div className="text-slate-400">
                  Phiên bản mới nhất trên GitHub
                </div>
                <div className="text-sm font-bold text-cyan-300 mt-1 font-mono flex flex-wrap items-center gap-2">
                  <span>v{updateInfo.latestVersion}</span>
                  {updateInfo.latestCommit && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300">
                      #{updateInfo.latestCommit}
                    </span>
                  )}
                </div>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="text-slate-400">Trạng thái đồng bộ</div>
                  {updateInfo.hasUpdate ? (
                    <div className="text-amber-300 font-semibold mt-1">
                      🚀 Có bản cập nhật mới sẵn sàng!
                    </div>
                  ) : (
                    <div className="text-emerald-400 font-semibold mt-1 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>Đang ở bản mới nhất</span>
                    </div>
                  )}
                </div>
                {updateInfo.latestPublishedAt && (
                  <div className="text-[11px] text-slate-500 sm:text-right">
                    Cập nhật cuối:
                    <br className="hidden sm:inline" />{' '}
                    {formatDateTime(updateInfo.latestPublishedAt)}
                  </div>
                )}
              </div>
            </div>
          )}

          {updateInfo?.blockingReason && (
            <div className="p-3 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 break-words">
              ⚠️ {updateInfo.blockingReason}
            </div>
          )}

          {updateInfo?.imageRebuildRecommended && (
            <div className="p-3 rounded-lg bg-cyan-500/15 border border-cyan-500/30 text-cyan-200 break-words">
              ℹ️{' '}
              {updateInfo.imageRebuildHint ||
                'Bản cập nhật này có thay đổi ở tầng Base Image / docker-entrypoint.sh — khuyến nghị chạy thêm bash update.sh trên máy chủ NAS để đồng bộ container nền mới nhất.'}
            </div>
          )}

          {updateInfo?.changelog && (
            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 space-y-1">
              <div className="text-[11px] font-semibold text-slate-300 break-words">
                {updateInfo.releaseTitle ||
                  'Ghi chú Commit / Phiên bản mới nhất trên GitHub:'}
              </div>
              <pre className="text-[11px] text-slate-400 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
                {updateInfo.changelog}
              </pre>
            </div>
          )}

          {updateProgress && (
            <div className="p-4 rounded-xl bg-slate-950 border border-blue-500/30 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`font-semibold break-words ${
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
                <span className="font-mono text-slate-300 shrink-0">
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
                <pre className="p-3 rounded-lg bg-black/70 border border-slate-800 text-[11px] text-slate-300 font-mono max-h-56 overflow-y-auto whitespace-pre-wrap break-words">
                  {updateLogs.join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

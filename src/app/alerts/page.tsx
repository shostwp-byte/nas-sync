'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  BellRing,
  CheckCheck,
  CheckCircle2,
  ExternalLink,
  FileText,
  Info,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useRealtime } from '@/components/SocketProvider';
import { formatDateTime } from '@/lib/format';
import type { AuditLogRecord, SystemAlert, UserRole } from '@/types';

type AlertsViewTab = 'alerts' | 'audit';
type SeverityFilter = 'ALL' | 'UNREAD' | 'CRITICAL' | 'WARNING' | 'INFO';

interface AlertsSummary {
  totalCount: number;
  unreadCount: number;
  criticalUnreadCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
}

const CATEGORY_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: 'ALL', label: 'Tất cả phân mục' },
  { value: 'BACKUP', label: 'BACKUP — Sao lưu' },
  { value: 'RESTORE', label: 'RESTORE — Khôi phục' },
  { value: 'ANOMALY', label: 'ANOMALY — Phát hiện bất thường' },
  { value: 'VOLUME', label: 'VOLUME — Ổ cứng & Phân vùng' },
  { value: 'BTRFS', label: 'BTRFS — Snapshot WORM' },
  { value: 'SYSTEM', label: 'SYSTEM — Hệ thống & Cập nhật' },
];

function getSeverityMeta(severity: SystemAlert['severity']): {
  label: string;
  badgeClass: string;
  cardClass: string;
  icon: React.ComponentType<{ className?: string }>;
} {
  switch (severity) {
    case 'CRITICAL':
      return {
        label: 'Nghiêm trọng',
        badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
        cardClass: 'bg-rose-950/20 border-rose-500/35',
        icon: ShieldAlert,
      };
    case 'WARNING':
      return {
        label: 'Cảnh báo',
        badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        cardClass: 'bg-amber-950/15 border-amber-500/30',
        icon: AlertTriangle,
      };
    default:
      return {
        label: 'Thông tin',
        badgeClass: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
        cardClass: 'bg-slate-900 border-slate-800',
        icon: Info,
      };
  }
}

function getCategoryBadgeClass(category: SystemAlert['category']): string {
  switch (category) {
    case 'ANOMALY':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'BACKUP':
      return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    case 'RESTORE':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/30';
    case 'VOLUME':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'BTRFS':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    default:
      return 'bg-slate-800 text-slate-300 border-slate-700';
  }
}

function getAuditActionBadgeClass(action: string): string {
  const upper = (action || '').toUpperCase();
  if (
    upper.includes('FAIL') ||
    upper.includes('DELETE') ||
    upper.includes('REMOVE') ||
    upper.includes('DISABLE') ||
    upper.includes('CLEAR')
  ) {
    return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  }
  if (
    upper.includes('CREATE') ||
    upper.includes('ADD') ||
    upper.includes('ENABLE')
  ) {
    return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  }
  if (
    upper.includes('RESTORE') ||
    upper.includes('ROLLBACK') ||
    upper.includes('UPDATE') ||
    upper.includes('PATCH')
  ) {
    return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  }
  if (
    upper.includes('LOGIN') ||
    upper.includes('LOGOUT') ||
    upper.includes('2FA') ||
    upper.includes('AUTH')
  ) {
    return 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30';
  }
  return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
}

export default function AlertsAndLogsPage() {
  const { lastUpdateCounter } = useRealtime();

  const [role, setRole] = useState<UserRole>('VIEWER');
  const [activeTab, setActiveTab] = useState<AlertsViewTab>('alerts');

  // System Alerts State
  const [alerts, setAlerts] = useState<SystemAlert[]>([]);
  const [summary, setSummary] = useState<AlertsSummary>({
    totalCount: 0,
    unreadCount: 0,
    criticalUnreadCount: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
  });
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Audit Logs State (Admin Tab)
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditQuery, setAuditQuery] = useState('');
  const [auditActionFilter, setAuditActionFilter] = useState('ALL');

  const isAdmin = role === 'ADMIN';
  const canWrite = role === 'ADMIN' || role === 'OPERATOR';

  const loadAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/api/alerts?limit=250', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        setAlerts(json.alerts || []);
        if (json.summary) {
          setSummary(json.summary);
        }
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    try {
      const resp = await fetch('/api/audit-logs?limit=200', {
        cache: 'no-store',
      });
      if (resp.ok) {
        const json = await resp.json();
        setAuditLogs(json.logs || []);
      }
    } catch {
      // Ignore transient network errors
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!active || !json?.user) return;
        const userRole = (json.user.role as UserRole) || 'VIEWER';
        setRole(userRole);
        if (userRole === 'ADMIN') {
          void loadAuditLogs();
        }
      })
      .catch(() => {});

    void loadAlerts();
    return () => {
      active = false;
    };
  }, [loadAlerts, loadAuditLogs]);

  useEffect(() => {
    if (lastUpdateCounter > 0) {
      void loadAlerts();
    }
  }, [lastUpdateCounter, loadAlerts]);

  const notifyShellAlertsChanged = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('nas-sync:alerts-changed'));
    }
  };

  const handleMarkAllRead = async () => {
    setBusyAction(true);
    setFeedback('');
    try {
      const resp = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'mark_all_read' }),
      });
      if (resp.ok) {
        await loadAlerts();
        notifyShellAlertsChanged();
        setFeedback('✅ Đã đánh dấu toàn bộ thông báo và cảnh báo là đã đọc.');
      }
    } finally {
      setBusyAction(false);
    }
  };

  const handleMarkSingleRead = async (alertId: number) => {
    const resp = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_read', alertId }),
    });
    if (resp.ok) {
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, is_read: 1 } : a))
      );
      setSummary((prev) => ({
        ...prev,
        unreadCount: Math.max(0, prev.unreadCount - 1),
      }));
      notifyShellAlertsChanged();
    }
  };

  const handleClearRead = async () => {
    if (
      !window.confirm(
        'Xóa toàn bộ các thông báo đã đọc khỏi danh sách? (Các cảnh báo CHƯA ĐỌC sẽ được giữ nguyên).'
      )
    ) {
      return;
    }
    setBusyAction(true);
    setFeedback('');
    try {
      const resp = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_read' }),
      });
      const json = await resp.json().catch(() => ({}));
      if (resp.ok) {
        await loadAlerts();
        if (isAdmin) {
          void loadAuditLogs();
        }
        notifyShellAlertsChanged();
        setFeedback(
          `✅ Đã dọn dẹp ${Number(json.deleted || 0)} thông báo đã đọc.`
        );
      }
    } finally {
      setBusyAction(false);
    }
  };

  const filteredAlerts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return alerts.filter((a) => {
      if (severityFilter === 'UNREAD' && a.is_read !== 0) return false;
      if (
        (severityFilter === 'CRITICAL' ||
          severityFilter === 'WARNING' ||
          severityFilter === 'INFO') &&
        a.severity !== severityFilter
      ) {
        return false;
      }
      if (categoryFilter !== 'ALL' && a.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.message.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      );
    });
  }, [alerts, severityFilter, categoryFilter, searchQuery]);

  const uniqueAuditActions = useMemo(() => {
    const set = new Set<string>();
    for (const item of auditLogs) {
      if (item.action) set.add(item.action);
    }
    return Array.from(set).sort();
  }, [auditLogs]);

  const filteredAuditLogs = useMemo(() => {
    const q = auditQuery.trim().toLowerCase();
    return auditLogs.filter((log) => {
      if (auditActionFilter !== 'ALL' && log.action !== auditActionFilter) {
        return false;
      }
      if (!q) return true;
      return (
        (log.username || '').toLowerCase().includes(q) ||
        (log.action || '').toLowerCase().includes(q) ||
        (log.resource_type || '').toLowerCase().includes(q) ||
        (log.resource_id || '').toLowerCase().includes(q) ||
        (log.detail || '').toLowerCase().includes(q) ||
        (log.ip_address || '').toLowerCase().includes(q)
      );
    });
  }, [auditLogs, auditActionFilter, auditQuery]);

  return (
    <div className="space-y-5 sm:space-y-6 min-w-0">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <BellRing className="w-5 h-5 text-amber-400 shrink-0" />
            <span>Nhật ký Sự kiện &amp; Cảnh báo Hệ thống</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Theo dõi tập trung toàn bộ sự kiện Sao lưu, Khôi phục, Offsite
            Cloud, cảnh báo Ransomware / SSH TOFU và nhật ký kiểm toán bảo mật.
          </p>
        </div>

        {isAdmin && (
          <Link
            href="/settings"
            className="w-full sm:w-auto justify-center min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-200 border border-slate-700 transition-colors shrink-0"
          >
            <Settings className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span>Cấu hình Kênh Telegram &amp; SMTP</span>
          </Link>
        )}
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <button
          type="button"
          onClick={() => {
            setActiveTab('alerts');
            setSeverityFilter('ALL');
          }}
          className="text-left p-3.5 sm:p-4 rounded-2xl bg-slate-900 border border-slate-800 hover:border-slate-700 transition-colors space-y-1"
        >
          <div className="text-[11px] text-slate-400">Tổng sự kiện hệ thống</div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-white">
            {summary.totalCount}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('alerts');
            setSeverityFilter('UNREAD');
          }}
          className="text-left p-3.5 sm:p-4 rounded-2xl bg-slate-900 border border-blue-500/25 hover:border-blue-500/50 transition-colors space-y-1"
        >
          <div className="text-[11px] text-blue-300">Chưa đọc</div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-blue-300">
            {summary.unreadCount}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('alerts');
            setSeverityFilter('CRITICAL');
          }}
          className="text-left p-3.5 sm:p-4 rounded-2xl bg-slate-900 border border-rose-500/25 hover:border-rose-500/50 transition-colors space-y-1"
        >
          <div className="text-[11px] text-rose-300">
            Nghiêm trọng (CRITICAL)
          </div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-rose-300">
            {summary.criticalCount}
          </div>
        </button>

        <button
          type="button"
          onClick={() => {
            setActiveTab('alerts');
            setSeverityFilter('WARNING');
          }}
          className="text-left p-3.5 sm:p-4 rounded-2xl bg-slate-900 border border-amber-500/25 hover:border-amber-500/50 transition-colors space-y-1"
        >
          <div className="text-[11px] text-amber-300">Cảnh báo (WARNING)</div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-amber-300">
            {summary.warningCount}
          </div>
        </button>
      </div>

      {/* Tab Switcher (System Alerts + Admin Security Audit Logs) */}
      {isAdmin && (
        <div className="flex flex-wrap gap-1.5 p-1.5 bg-slate-900 border border-slate-800 rounded-2xl text-xs">
          <button
            type="button"
            onClick={() => setActiveTab('alerts')}
            className={`flex-1 sm:flex-initial min-h-[42px] px-4 py-2 rounded-xl font-semibold inline-flex items-center justify-center gap-2 transition-all ${
              activeTab === 'alerts'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <BellRing className="w-4 h-4 shrink-0" />
            <span>Sự kiện &amp; Cảnh báo Hệ thống</span>
            {summary.unreadCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-white/20 text-white font-mono">
                {summary.unreadCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab('audit');
              if (auditLogs.length === 0) {
                void loadAuditLogs();
              }
            }}
            className={`flex-1 sm:flex-initial min-h-[42px] px-4 py-2 rounded-xl font-semibold inline-flex items-center justify-center gap-2 transition-all ${
              activeTab === 'audit'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/25'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <FileText className="w-4 h-4 shrink-0" />
            <span>Nhật ký Kiểm toán Bảo mật (Audit Logs)</span>
          </button>
        </div>
      )}

      {feedback && (
        <div className="p-3.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-200 flex items-center gap-2 break-words">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {/* =====================================================================
          TAB 1: SỰ KIỆN & CẢNH BÁO HỆ THỐNG (ALL ROLES)
         ===================================================================== */}
      {activeTab === 'alerts' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden text-xs">
          {/* Filter & Action Toolbar */}
          <div className="p-4 sm:p-5 border-b border-slate-800 space-y-3.5">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              {/* Severity Filter Pills */}
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { key: 'ALL', label: `Tất cả (${alerts.length})` },
                    { key: 'UNREAD', label: `Chưa đọc (${summary.unreadCount})` },
                    {
                      key: 'CRITICAL',
                      label: `Nghiêm trọng (${summary.criticalCount})`,
                    },
                    {
                      key: 'WARNING',
                      label: `Cảnh báo (${summary.warningCount})`,
                    },
                    { key: 'INFO', label: `Thông tin (${summary.infoCount})` },
                  ] as Array<{ key: SeverityFilter; label: string }>
                ).map((pill) => {
                  const active = severityFilter === pill.key;
                  return (
                    <button
                      key={pill.key}
                      type="button"
                      onClick={() => setSeverityFilter(pill.key)}
                      className={`min-h-[36px] px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                        active
                          ? 'bg-blue-600/25 border-blue-500/50 text-blue-200'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {pill.label}
                    </button>
                  );
                })}
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-2">
                {canWrite && (
                  <button
                    type="button"
                    disabled={busyAction || summary.unreadCount === 0}
                    onClick={() => void handleMarkAllRead()}
                    className="min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 font-medium disabled:opacity-40 transition-colors"
                  >
                    <CheckCheck className="w-3.5 h-3.5 shrink-0" />
                    <span>Đánh dấu tất cả đã đọc</span>
                  </button>
                )}

                {isAdmin && (
                  <button
                    type="button"
                    disabled={
                      busyAction ||
                      alerts.every((item) => item.is_read === 0)
                    }
                    onClick={() => void handleClearRead()}
                    className="min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/20 text-slate-300 hover:text-rose-300 border border-slate-700 hover:border-rose-500/35 font-medium disabled:opacity-40 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Dọn thông báo đã đọc</span>
                  </button>
                )}

                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void loadAlerts()}
                  className="min-h-[38px] inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 shrink-0 ${
                      loading ? 'animate-spin' : ''
                    }`}
                  />
                  <span>Làm mới</span>
                </button>
              </div>
            </div>

            {/* Search Input & Category Selector */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5">
              <div className="md:col-span-8 relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm kiếm theo tiêu đề, tên miền, máy chủ hoặc nội dung sự kiện..."
                  className="w-full min-h-[40px] bg-slate-950 border border-slate-800 focus:border-blue-500 rounded-xl pl-8 pr-3 py-2 text-white outline-none"
                />
              </div>

              <div className="md:col-span-4">
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="w-full min-h-[40px] bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200"
                >
                  {CATEGORY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Alerts Feed List */}
          <div className="p-4 sm:p-5 space-y-3">
            {loading && alerts.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                Đang tải nhật ký sự kiện và cảnh báo hệ thống...
              </div>
            ) : filteredAlerts.length === 0 ? (
              <div className="py-12 text-center text-slate-500 space-y-1.5">
                <BellRing className="w-7 h-7 text-slate-600 mx-auto" />
                <div>
                  {alerts.length === 0
                    ? 'Hệ thống hoạt động ổn định, chưa có sự kiện hay cảnh báo nào.'
                    : 'Không tìm thấy sự kiện nào khớp bộ lọc hiện tại.'}
                </div>
              </div>
            ) : (
              filteredAlerts.map((a) => {
                const sev = getSeverityMeta(a.severity);
                const SevIcon = sev.icon;
                const isUnread = a.is_read === 0;

                return (
                  <div
                    key={a.id}
                    className={`p-3.5 sm:p-4 rounded-xl border transition-colors space-y-2 ${
                      sev.cardClass
                    } ${
                      isUnread
                        ? 'ring-1 ring-blue-500/35 bg-slate-950/90'
                        : 'bg-slate-950/60 opacity-90'
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <SevIcon className="w-4 h-4 mt-0.5 shrink-0 text-current" />
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {isUnread && (
                              <span
                                title="Sự kiện chưa đọc"
                                className="w-2 h-2 rounded-full bg-blue-400 shrink-0"
                              />
                            )}
                            <span
                              className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide ${sev.badgeClass}`}
                            >
                              {sev.label}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded border font-mono text-[10px] font-semibold ${getCategoryBadgeClass(
                                a.category
                              )}`}
                            >
                              {a.category}
                            </span>
                            <span className="font-semibold text-sm text-white break-words">
                              {a.title}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 shrink-0 pl-6 sm:pl-0">
                        <span className="text-[11px] text-slate-400 font-mono">
                          {formatDateTime(a.created_at)}
                        </span>
                        {canWrite && isUnread && (
                          <button
                            type="button"
                            onClick={() => void handleMarkSingleRead(a.id)}
                            className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] text-slate-200 border border-slate-700 transition-colors"
                          >
                            Đã đọc
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="text-slate-300 leading-relaxed break-words pl-6">
                      {a.message}
                    </p>

                    {a.job_id !== null && a.job_id > 0 && (
                      <div className="pl-6 pt-0.5">
                        <Link
                          href="/jobs"
                          className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-medium"
                        >
                          <span>Xem Tiến trình Job #{a.job_id}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 2: NHẬT KÝ KIỂM TOÁN BẢO MẬT (AUDIT LOGS — ADMIN ONLY)
         ===================================================================== */}
      {isAdmin && activeTab === 'audit' && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden text-xs">
          <div className="p-4 sm:p-5 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <FileText className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  Nhật ký Kiểm toán Bảo mật (Audit Logs — 200 sự kiện gần nhất)
                </span>
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Ghi vết đầy đủ tài khoản, hành động, đối tượng tác động và địa
                chỉ IP thực thi.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full lg:w-auto">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  value={auditQuery}
                  onChange={(e) => setAuditQuery(e.target.value)}
                  placeholder="Lọc user, hành động, IP..."
                  className="w-full min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-white"
                />
              </div>

              <select
                value={auditActionFilter}
                onChange={(e) => setAuditActionFilter(e.target.value)}
                className="min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 font-mono"
              >
                <option value="ALL">Tất cả hành động</option>
                {uniqueAuditActions.map((act) => (
                  <option key={act} value={act}>
                    {act}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => void loadAuditLogs()}
                disabled={auditLoading}
                className="min-h-[40px] justify-center inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 whitespace-nowrap transition-colors"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 shrink-0 ${
                    auditLoading ? 'animate-spin' : ''
                  }`}
                />
                <span>Làm mới</span>
              </button>
            </div>
          </div>

          {/* Mobile Audit Cards (< md) */}
          <div className="md:hidden divide-y divide-slate-800">
            {auditLoading ? (
              <div className="p-8 text-center text-slate-500">
                Đang tải nhật ký kiểm toán...
              </div>
            ) : filteredAuditLogs.length === 0 ? (
              <div className="p-8 text-center text-slate-500">
                Không có bản ghi kiểm toán nào khớp bộ lọc.
              </div>
            ) : (
              filteredAuditLogs.map((log) => (
                <div key={log.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold ${getAuditActionBadgeClass(
                        log.action
                      )}`}
                    >
                      {log.action}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {formatDateTime(log.created_at)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-mono font-semibold text-cyan-300 break-all">
                      👤 {log.username || 'system'}
                    </span>
                    <span className="font-mono text-slate-400">
                      IP: {log.ip_address || '—'}
                    </span>
                  </div>

                  {(log.resource_type || log.resource_id) && (
                    <div className="font-mono text-[11px] text-slate-300 break-all">
                      Tài nguyên: {log.resource_type}
                      {log.resource_id ? ` #${log.resource_id}` : ''}
                    </div>
                  )}

                  {log.detail && (
                    <div className="p-2.5 rounded-lg bg-slate-950 border border-slate-800/80 text-slate-300 break-words">
                      {log.detail}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Desktop Audit Table (>= md) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="bg-slate-950/70 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="p-3.5 font-medium">Thời gian</th>
                  <th className="p-3.5 font-medium">Người dùng</th>
                  <th className="p-3.5 font-medium">Hành động</th>
                  <th className="p-3.5 font-medium">Tài nguyên</th>
                  <th className="p-3.5 font-medium">Chi tiết</th>
                  <th className="p-3.5 font-medium">Địa chỉ IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {auditLoading ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      Đang tải nhật ký kiểm toán...
                    </td>
                  </tr>
                ) : filteredAuditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      Không có bản ghi kiểm toán nào khớp bộ lọc.
                    </td>
                  </tr>
                ) : (
                  filteredAuditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-800/30">
                      <td className="p-3.5 whitespace-nowrap text-slate-400">
                        {formatDateTime(log.created_at)}
                      </td>
                      <td className="p-3.5 font-mono font-semibold text-cyan-300 whitespace-nowrap">
                        {log.username || 'system'}
                      </td>
                      <td className="p-3.5 whitespace-nowrap">
                        <span
                          className={`px-2 py-0.5 rounded border font-mono text-[10px] font-bold ${getAuditActionBadgeClass(
                            log.action
                          )}`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="p-3.5 font-mono text-slate-300 whitespace-nowrap">
                        {log.resource_type || '—'}
                        {log.resource_id ? ` #${log.resource_id}` : ''}
                      </td>
                      <td className="p-3.5 text-slate-300 max-w-md break-words">
                        {log.detail || '—'}
                      </td>
                      <td className="p-3.5 font-mono text-slate-400 whitespace-nowrap">
                        {log.ip_address || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


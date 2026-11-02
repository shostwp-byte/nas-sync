'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  ArrowUpCircle,
  BellRing,
  CalendarClock,
  ExternalLink,
  FolderGit2,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  RotateCcw,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  User,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { UserRole } from '@/types';
import { useRealtime } from './SocketProvider';

const NAV_ITEMS = [
  { href: '/', label: 'Tổng quan NOC', icon: LayoutDashboard },
  { href: '/servers', label: 'Máy chủ VPS & SSH', icon: Server },
  { href: '/volumes', label: 'Phân vùng Synology', icon: HardDrive },
  { href: '/jobs', label: 'Tiến trình & Lịch sử', icon: Activity },
  { href: '/schedules', label: 'Lập lịch & GFS', icon: CalendarClock },
  { href: '/restore', label: 'Khôi phục & Di chuyển', icon: RotateCcw },
  { href: '/explorer', label: 'File Explorer & Diff', icon: FolderGit2 },
  { href: '/alerts', label: 'Nhật ký & Cảnh báo', icon: BellRing },
  { href: '/settings', label: 'Cấu hình & Cập nhật', icon: Settings },
];

function getRoleBadgeStyle(role: UserRole): string {
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connected, progressMap, latestAlert, lastUpdateCounter } =
    useRealtime();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [alertCounts, setAlertCounts] = useState<{
    unreadCount: number;
    criticalUnreadCount: number;
  }>({ unreadCount: 0, criticalUnreadCount: 0 });
  const [currentUser, setCurrentUser] = useState<{
    userId: number;
    username: string;
    role: UserRole;
    totpEnabled: boolean;
  } | null>(null);
  const [versionInfo, setVersionInfo] = useState<{
    currentVersion: string;
    hasUpdate: boolean;
  }>({ currentVersion: '1.5.2', hasUpdate: false });

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileOpen]);

  useEffect(() => {
    if (pathname === '/login') return;
    let active = true;

    const refreshAlertCounts = () => {
      fetch('/api/alerts?limit=1', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (active && data?.summary) {
            setAlertCounts({
              unreadCount: Number(data.summary.unreadCount || 0),
              criticalUnreadCount: Number(
                data.summary.criticalUnreadCount || 0
              ),
            });
          }
        })
        .catch(() => {});
    };

    refreshAlertCounts();

    const onAlertsChanged = () => refreshAlertCounts();
    window.addEventListener('nas-sync:alerts-changed', onAlertsChanged);

    return () => {
      active = false;
      window.removeEventListener('nas-sync:alerts-changed', onAlertsChanged);
    };
  }, [pathname, lastUpdateCounter]);

  useEffect(() => {
    if (pathname === '/login') return;
    let active = true;

    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.user) {
          setCurrentUser({
            userId: Number(data.user.userId ?? data.user.id ?? 0),
            username: String(data.user.username || 'admin'),
            role: (data.user.role as UserRole) || 'ADMIN',
            totpEnabled: Boolean(
              data.user.totpEnabled ?? data.user.totp_enabled
            ),
          });
        }
      })
      .catch(() => {});

    fetch('/api/system/update')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.currentVersion) {
          setVersionInfo({
            currentVersion: data.currentVersion,
            hasUpdate: Boolean(data.hasUpdate),
          });
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [pathname]);

  if (pathname === '/login') {
    return <>{children}</>;
  }

  const runningCount = Object.values(progressMap).filter((p) =>
    ['RUNNING', 'RESUMING', 'VERIFYING'].includes(p.status)
  ).length;

  const criticalCount = alertCounts.criticalUnreadCount;

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      {/* Mobile Backdrop Overlay */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
          className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm lg:hidden"
        />
      )}

      {/* Sidebar Drawer (Mobile) & Fixed Sidebar (Desktop) */}
      <aside
        className={`fixed top-0 left-0 z-50 h-dvh w-64 max-w-[85vw] bg-slate-900/95 border-r border-slate-800 flex flex-col transition-transform duration-200 lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-4 flex items-center justify-between gap-2 border-b border-slate-800 shrink-0">
          <Link
            href="/"
            onClick={() => setMobileOpen(false)}
            className="flex items-center gap-3 min-w-0"
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-blue-500/20 shrink-0">
              <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div className="min-w-0">
              <div className="font-bold text-sm tracking-wide text-white flex items-center gap-1.5">
                <span className="truncate">NAS-SYNC</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono shrink-0">
                  v{versionInfo.currentVersion}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                Synology Agentless Pull
              </div>
            </div>
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Đóng menu điều hướng"
            className="lg:hidden h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto overscroll-contain">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center justify-between px-3.5 py-2.5 min-h-[42px] rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-3 min-w-0">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>
                {item.href === '/jobs' && runningCount > 0 && (
                  <span className="px-2 py-0.5 text-[11px] rounded-full bg-blue-500 text-white animate-pulse shrink-0">
                    {runningCount}
                  </span>
                )}
                {item.href === '/alerts' && alertCounts.unreadCount > 0 && (
                  <span
                    className={`px-2 py-0.5 text-[11px] rounded-full font-mono font-semibold shrink-0 ${
                      alertCounts.criticalUnreadCount > 0
                        ? 'bg-rose-500 text-white animate-pulse'
                        : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    }`}
                  >
                    {alertCounts.unreadCount}
                  </span>
                )}
                {item.href === '/settings' &&
                  versionInfo.hasUpdate &&
                  (!currentUser || currentUser.role === 'ADMIN') && (
                    <span
                      title="Có bản cập nhật mới trên GitHub"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0"
                    >
                      <ArrowUpCircle className="w-3 h-3" />
                      Mới
                    </span>
                  )}
              </Link>
            );
          })}
        </nav>

        <div className="p-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))] border-t border-slate-800 space-y-2.5 shrink-0">
          <div className="px-3 py-2 rounded-lg bg-slate-950/80 border border-slate-800 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Realtime Socket</span>
              {connected ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 font-medium shrink-0">
                  <Wifi className="w-3.5 h-3.5" /> Đã kết nối
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-400 font-medium shrink-0">
                  <WifiOff className="w-3.5 h-3.5" /> Đang nối lại
                </span>
              )}
            </div>
            <a
              href="https://github.com/shostwp-byte/nas-sync"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-1 text-[11px] text-slate-400 hover:text-cyan-300 transition-colors pt-1 border-t border-slate-800/80"
            >
              <span className="truncate">github.com/shostwp-byte/nas-sync</span>
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </div>

          {currentUser && (
            <div className="px-3 py-2 rounded-lg bg-slate-950/90 border border-slate-800/90 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="inline-flex items-center gap-1.5 font-semibold text-white min-w-0">
                  <User className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                  <span className="truncate font-mono">
                    {currentUser.username}
                  </span>
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded border text-[10px] font-bold tracking-wide shrink-0 ${getRoleBadgeStyle(
                    currentUser.role
                  )}`}
                >
                  {currentUser.role}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/70">
                <span className="text-[11px] text-slate-400">Bảo mật 2 lớp</span>
                {currentUser.totpEnabled ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-semibold text-emerald-300 shrink-0">
                    <ShieldCheck className="w-3 h-3 shrink-0" />
                    2FA ON
                  </span>
                ) : (
                  <Link
                    href="/settings?tab=account"
                    onClick={() => {
                      setMobileOpen(false);
                      window.dispatchEvent(
                        new CustomEvent('nas-sync:settings-tab', {
                          detail: 'account',
                        })
                      );
                    }}
                    title="Nhấn để bật bảo mật 2 lớp (2FA TOTP)"
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-800 hover:bg-amber-500/20 border border-slate-700 hover:border-amber-500/40 text-[10px] font-medium text-slate-300 hover:text-amber-300 transition-colors shrink-0"
                  >
                    <ShieldAlert className="w-3 h-3 shrink-0" />
                    2FA OFF
                  </Link>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleLogout}
            className="w-full min-h-[40px] flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800/70 hover:bg-rose-600/20 hover:border-rose-500/40 border border-slate-700/70 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" />
            Đăng xuất an toàn
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="lg:pl-64 flex flex-col min-h-dvh min-w-0">
        <header className="min-h-16 bg-slate-900/60 backdrop-blur border-b border-slate-800 px-3.5 sm:px-6 py-2 gap-2.5 flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Mở menu điều hướng"
              className="lg:hidden h-10 w-10 inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors shrink-0"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="text-sm lg:text-base font-semibold text-slate-100 truncate">
                <span className="sm:hidden">NAS-Sync NOC</span>
                <span className="hidden sm:inline">
                  NAS-Sync — Hệ thống Sao lưu & Khôi phục Đa Máy chủ
                </span>
              </h1>
              <p className="text-xs text-slate-400 hidden md:block truncate">
                DirectAdmin • cPanel • Plesk • aaPanel • CyberPanel • HestiaCP • CloudPanel ➔ Synology NAS
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {versionInfo.hasUpdate &&
              (!currentUser || currentUser.role === 'ADMIN') && (
                <Link
                  href="/settings?tab=update"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('nas-sync:settings-tab', {
                        detail: 'update',
                      })
                    );
                  }}
                  className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 whitespace-nowrap"
                >
                  <ArrowUpCircle className="w-3.5 h-3.5 shrink-0" />
                  Có bản cập nhật GitHub
                </Link>
              )}
            {criticalCount > 0 && (
              <>
                <Link
                  href="/alerts"
                  title={latestAlert?.title || 'Cảnh báo hệ thống nghiêm trọng'}
                  aria-label={`Xem ${criticalCount} cảnh báo nghiêm trọng`}
                  className="md:hidden inline-flex items-center gap-1 px-2.5 py-1.5 min-h-[38px] rounded-full text-xs font-semibold bg-rose-500/20 border border-rose-500/40 text-rose-300 shrink-0"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>{criticalCount}</span>
                </Link>
                <Link
                  href="/alerts"
                  className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-500/20 border border-rose-500/40 text-rose-300 max-w-[260px]"
                >
                  <span className="shrink-0">🚨</span>
                  <span className="truncate">
                    {latestAlert?.title || `${criticalCount} cảnh báo nghiêm trọng`}
                  </span>
                </Link>
              </>
            )}
            {currentUser?.role === 'VIEWER' ? (
              <span
                title="Tài khoản chế độ chỉ xem (Read-Only NOC)"
                className="shrink-0 whitespace-nowrap min-h-[38px] inline-flex items-center px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/60 text-slate-400 border border-slate-800"
              >
                Chế độ Xem (NOC)
              </span>
            ) : (
              <Link
                href="/restore"
                className="shrink-0 whitespace-nowrap min-h-[38px] flex items-center px-3 sm:px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                1-Click Restore
              </Link>
            )}
          </div>
        </header>

        <main className="flex-1 p-3.5 sm:p-6 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-w-[1600px] w-full mx-auto min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}

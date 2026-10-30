'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  ArrowUpCircle,
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
  ShieldCheck,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { useRealtime } from './SocketProvider';

const NAV_ITEMS = [
  { href: '/', label: 'Tổng quan NOC', icon: LayoutDashboard },
  { href: '/servers', label: 'Máy chủ VPS & SSH', icon: Server },
  { href: '/volumes', label: 'Phân vùng Synology', icon: HardDrive },
  { href: '/jobs', label: 'Tiến trình & Lịch sử', icon: Activity },
  { href: '/schedules', label: 'Lập lịch & GFS', icon: CalendarClock },
  { href: '/restore', label: 'Khôi phục & Di chuyển', icon: RotateCcw },
  { href: '/explorer', label: 'File Explorer & Diff', icon: FolderGit2 },
  { href: '/settings', label: 'Cấu hình & Cập nhật', icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { connected, progressMap, latestAlert } = useRealtime();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [versionInfo, setVersionInfo] = useState<{
    currentVersion: string;
    hasUpdate: boolean;
  }>({ currentVersion: '1.1.0', hasUpdate: false });

  useEffect(() => {
    if (pathname === '/login') return;
    let active = true;
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

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex">
      {/* Sidebar Desktop */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900/95 border-r border-slate-800 flex flex-col transition-transform duration-200 lg:translate-x-0 lg:static ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <ShieldCheck className="w-5 h-5 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="font-bold text-sm tracking-wide text-white flex items-center gap-1.5">
                <span>NAS-SYNC</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono">
                  v{versionInfo.currentVersion}
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                Synology Agentless Pull
              </div>
            </div>
          </Link>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden p-1.5 text-slate-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
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
                className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-3">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.href === '/jobs' && runningCount > 0 && (
                  <span className="px-2 py-0.5 text-[11px] rounded-full bg-blue-500 text-white animate-pulse">
                    {runningCount}
                  </span>
                )}
                {item.href === '/settings' && versionInfo.hasUpdate && (
                  <span
                    title="Có bản cập nhật mới trên GitHub"
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  >
                    <ArrowUpCircle className="w-3 h-3" />
                    Mới
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="px-3 py-2.5 rounded-lg bg-slate-950/80 border border-slate-800 text-xs space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-slate-400">Realtime Socket</span>
              {connected ? (
                <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                  <Wifi className="w-3.5 h-3.5" /> Đã kết nối
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-400 font-medium">
                  <WifiOff className="w-3.5 h-3.5" /> Đang nối lại
                </span>
              )}
            </div>
            <a
              href="https://github.com/shostwp-byte/nas-sync"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between text-[11px] text-slate-400 hover:text-cyan-300 transition-colors pt-1 border-t border-slate-800/80"
            >
              <span className="truncate">github.com/shostwp-byte/nas-sync</span>
              <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
          </div>

          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-white bg-slate-800/70 hover:bg-rose-600/20 hover:border-rose-500/40 border border-slate-700/70 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Đăng xuất quản trị
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-slate-900/60 backdrop-blur border-b border-slate-800 px-4 lg:px-8 flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg bg-slate-800 text-slate-200"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-sm lg:text-base font-semibold text-slate-100">
                NAS-Sync — Hệ thống Sao lưu & Khôi phục Đa Máy chủ
              </h1>
              <p className="text-xs text-slate-400 hidden sm:block">
                DirectAdmin • cPanel • Plesk • aaPanel (Domain & Subdomain) ➔ Synology NAS
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {versionInfo.hasUpdate && (
              <Link
                href="/settings"
                className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                Có bản cập nhật GitHub
              </Link>
            )}
            {latestAlert && latestAlert.severity === 'CRITICAL' && (
              <Link
                href="/settings"
                className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-500/20 border border-rose-500/40 text-rose-300"
              >
                🚨 {latestAlert.title}
              </Link>
            )}
            <Link
              href="/restore"
              className="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
            >
              1-Click Restore
            </Link>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-8 max-w-[1600px] w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

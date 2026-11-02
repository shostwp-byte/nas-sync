'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Database,
  FolderGit2,
  Globe,
  HardDrive,
  Lock,
  Play,
  RefreshCw,
  Server,
  ShieldAlert,
  Sparkles,
  Terminal,
  TrendingUp,
} from 'lucide-react';
import { useRealtime } from '@/components/SocketProvider';
import {
  formatBytes,
  formatDateTime,
  formatEta,
  formatSpeed,
  getJobStatusMeta,
  getPanelBadgeClass,
} from '@/lib/format';
import type {
  BackupJob,
  ServerRecord,
  StorageDailyStat,
  StorageVolume,
  SystemAlert,
  TopDomainStat,
  UserRole,
} from '@/types';

interface DashboardData {
  stats: {
    totalServers: number;
    onlineServers: number;
    totalSnapshots: number;
    activeJobsCount: number;
    verifiedItemsCount: number;
    pinnedSnapshotsCount: number;
    anomalyCount: number;
    logicalBytes: number;
    physicalDeltaBytes: number;
    savingsPercent: number;
    unreadAlertsCount: number;
  };
  volumes: StorageVolume[];
  recentJobs: BackupJob[];
  recentAlerts: SystemAlert[];
  storageHistory?: StorageDailyStat[];
  topDomains?: TopDomainStat[];
  runtime: {
    mode: string;
    activeSchedulesCount: number;
  };
}

function formatDayMonth(rawDate: string): string {
  if (!rawDate) return '—';
  const clean = rawDate.slice(0, 10);
  const parts = clean.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return rawDate;
}

function formatDayMonthYear(rawDate: string): string {
  if (!rawDate) return '—';
  const clean = rawDate.slice(0, 10);
  const parts = clean.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return rawDate;
}

function formatCompactBytes(bytes: number | null | undefined): string {
  const b = Number(bytes || 0);
  if (b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(
    units.length - 1,
    Math.floor(Math.log(b) / Math.log(1024))
  );
  const val = b / Math.pow(1024, idx);
  return `${val >= 10 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

export default function DashboardPage() {
  const { progressMap, liveLogs, lastUpdateCounter, clearLogs } = useRealtime();
  const [data, setData] = useState<DashboardData | null>(null);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingServerId, setStartingServerId] = useState<number | null>(null);
  const [userRole, setUserRole] = useState<UserRole>('ADMIN');

  // 30-Day Storage Trend Chart State
  const [chartMode, setChartMode] = useState<'delta' | 'logical'>('delta');
  const [hoveredDayIdx, setHoveredDayIdx] = useState<number | null>(null);
  const [pinnedDayIdx, setPinnedDayIdx] = useState<number | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const [dashResp, srvResp] = await Promise.all([
        fetch('/api/dashboard'),
        fetch('/api/servers'),
      ]);
      if (dashResp.ok) {
        setData(await dashResp.json());
      }
      if (srvResp.ok) {
        const sJson = await srvResp.json();
        setServers(sJson.servers || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (active && me?.user?.role) {
          setUserRole(me.user.role as UserRole);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard, lastUpdateCounter]);

  const sortedHistory = useMemo(() => {
    const raw = data?.storageHistory || [];
    return [...raw].sort((a, b) => a.stat_date.localeCompare(b.stat_date));
  }, [data?.storageHistory]);

  const topDomains = useMemo(
    () => (data?.topDomains || []).slice(0, 10),
    [data?.topDomains]
  );

  const triggerQuickBackup = async (serverId: number) => {
    setStartingServerId(serverId);
    try {
      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, verifyDb: true }),
      });
      await loadDashboard();
    } finally {
      setStartingServerId(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        Đang tải dữ liệu Trung tâm Điều hành Sao lưu (NOC)...
      </div>
    );
  }

  const stats = data?.stats;
  const activeJobs = (data?.recentJobs || []).filter((j) =>
    ['QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED'].includes(
      progressMap[j.id]?.status || j.status
    )
  );

  // Precompute 30-day SVG chart geometry
  const svgW = 680;
  const svgH = 224;
  const padL = 62;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;
  const historyCount = sortedHistory.length;

  const seriesValues = sortedHistory.map((item) =>
    chartMode === 'delta'
      ? Math.max(0, Number(item.physical_delta_bytes || 0))
      : Math.max(0, Number(item.logical_bytes || 0))
  );
  const maxChartVal = Math.max(...seriesValues, 1024);

  const getChartX = (idx: number) =>
    historyCount <= 1
      ? padL + plotW / 2
      : padL + (idx / (historyCount - 1)) * plotW;

  const getChartY = (val: number) =>
    padT + plotH - Math.min(1, Math.max(0, val / maxChartVal)) * plotH;

  const chartPoints = sortedHistory.map((item, idx) => ({
    x: getChartX(idx),
    y: getChartY(seriesValues[idx]),
    val: seriesValues[idx],
    deltaVal: Math.max(0, Number(item.physical_delta_bytes || 0)),
    item,
  }));

  const polylinePoints = chartPoints
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ');

  const areaPath =
    chartPoints.length >= 2
      ? `M ${chartPoints[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} L ${chartPoints
          .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
          .join(' L ')} L ${chartPoints[chartPoints.length - 1].x.toFixed(1)},${(
          padT + plotH
        ).toFixed(1)} Z`
      : '';

  const xTickIndices: number[] = [];
  if (historyCount <= 6) {
    for (let i = 0; i < historyCount; i++) xTickIndices.push(i);
  } else {
    const segments = 5;
    for (let s = 0; s <= segments; s++) {
      const idx = Math.round((s / segments) * (historyCount - 1));
      if (!xTickIndices.includes(idx)) xTickIndices.push(idx);
    }
  }

  const rawActiveIdx =
    hoveredDayIdx !== null
      ? hoveredDayIdx
      : pinnedDayIdx !== null
      ? pinnedDayIdx
      : historyCount - 1;
  const activeDayIdx =
    historyCount > 0
      ? Math.min(historyCount - 1, Math.max(0, rawActiveIdx))
      : -1;
  const activePoint = activeDayIdx >= 0 ? chartPoints[activeDayIdx] : null;

  const totalDelta30d = sortedHistory.reduce(
    (acc, item) => acc + Math.max(0, Number(item.physical_delta_bytes || 0)),
    0
  );
  const maxTopDomainBytes = Math.max(
    ...topDomains.map((d) => Number(d.total_domain_bytes || 0)),
    1
  );

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-slate-900 via-slate-900 to-blue-950/50 border border-slate-800 rounded-2xl p-4 sm:p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-blue-400 mb-1">
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>
              ENGINE:{' '}
              {data?.runtime.mode === 'BULLMQ_REDIS'
                ? 'BullMQ + Redis Cluster Queue'
                : 'Local Concurrent Queue (Windows/Standalone Compatible)'}{' '}
              • {data?.runtime.activeSchedulesCount || 0} lịch Cron đang bật
            </span>
          </div>
          <h2 className="text-base sm:text-lg font-bold text-white">
            Trung tâm Giám sát Sao lưu Tập trung NAS-Sync
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Tự động hóa Incremental Hard-Link, Stream nén SQL qua SSH không tốn ổ cứng VPS & Tự động chuyển Volume khi đầy.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto shrink-0">
          <button
            type="button"
            onClick={() => void loadDashboard()}
            className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            Làm mới
          </button>
          <Link
            href="/servers"
            className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 transition-colors"
          >
            <Server className="w-3.5 h-3.5 shrink-0" />
            Quản lý VPS
          </Link>
        </div>
      </div>

      {/* 4 KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5 sm:gap-4">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 text-slate-400 text-xs mb-2">
            <span>Máy chủ VPS Quản lý</span>
            <Server className="w-4 h-4 text-blue-400 shrink-0" />
          </div>
          <div className="text-2xl font-bold text-white">
            {stats?.onlineServers ?? 0}{' '}
            <span className="text-sm font-normal text-slate-400">
              / {stats?.totalServers ?? 0} Online
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Hỗ trợ DirectAdmin, cPanel, Plesk, aaPanel
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 text-slate-400 text-xs mb-2">
            <span>Bản Sao lưu & Kiểm định SQL</span>
            <Database className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>
          <div className="text-2xl font-bold text-white">
            {stats?.totalSnapshots ?? 0}{' '}
            <span className="text-sm font-normal text-emerald-400">
              Snapshots
            </span>
          </div>
          <div className="mt-2 text-xs text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{stats?.verifiedItemsCount ?? 0} Domain DB đạt chuẩn Verified ✅</span>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 text-slate-400 text-xs mb-2">
            <span>Hiệu quả Hard-Link Incremental</span>
            <HardDrive className="w-4 h-4 text-cyan-400 shrink-0" />
          </div>
          <div className="text-2xl font-bold text-white">
            {(stats?.savingsPercent ?? 0).toFixed(1)}%{' '}
            <span className="text-xs font-normal text-cyan-400">tiết kiệm</span>
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Thực tốn: {formatBytes(stats?.physicalDeltaBytes)} / Tổng logic:{' '}
            {formatBytes(stats?.logicalBytes)}
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 text-slate-400 text-xs mb-2">
            <span>An toàn Chống Ransomware</span>
            <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
          </div>
          <div className="text-2xl font-bold text-white flex flex-wrap items-baseline gap-2">
            <span>{stats?.pinnedSnapshotsCount ?? 0}</span>
            <span className="text-xs font-normal text-slate-400">
              bản khóa bảo vệ (Pinned)
            </span>
          </div>
          <div className="mt-2 text-xs text-slate-400 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>Phát hiện bất thường: {stats?.anomalyCount ?? 0} phiên</span>
          </div>
        </div>
      </div>

      {/* 30-Day Storage Growth Chart & Top 10 Largest Domains */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left (xl:col-span-7): 30-Day Storage Trend */}
        <div className="xl:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between space-y-4 min-w-0">
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Biểu đồ Tăng trưởng Dung lượng 30 Ngày</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Theo dõi dung lượng thực tốn mỗi ngày (Hard-Link Delta) & tổng dữ liệu được bảo vệ trên NAS
                </p>
              </div>

              {/* Mode Toggle Pills */}
              <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800 shrink-0">
                <button
                  type="button"
                  onClick={() => setChartMode('delta')}
                  className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                    chartMode === 'delta'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  Dung lượng thực tốn (Delta)
                </button>
                <button
                  type="button"
                  onClick={() => setChartMode('logical')}
                  className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                    chartMode === 'logical'
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm'
                      : 'text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                >
                  Tổng dữ liệu bảo vệ (Logical)
                </button>
              </div>
            </div>

            {historyCount === 0 ? (
              <div className="py-14 px-4 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl space-y-2">
                <BarChart3 className="w-7 h-7 text-slate-600 mx-auto" />
                <div>
                  Chưa có dữ liệu thống kê tăng trưởng 30 ngày gần nhất.
                </div>
                <div className="text-[11px] text-slate-600">
                  Biểu đồ sẽ tự động hiển thị ngay sau khi phiên sao lưu đầu tiên hoàn tất.
                </div>
              </div>
            ) : (
              <>
                {/* Interactive Point Inspector Bar (Zero-Overflow Mobile & Desktop) */}
                {activePoint && (
                  <div className="p-3 rounded-xl bg-slate-950/90 border border-slate-800 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md bg-slate-800 border border-slate-700 font-mono font-bold text-white">
                          {formatDayMonthYear(activePoint.item.stat_date)}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {pinnedDayIdx !== null
                            ? '📌 Đang ghim xem chi tiết'
                            : hoveredDayIdx !== null
                            ? '👆 Đang trỏ xem chi tiết'
                            : 'Mốc ngày mới nhất'}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300">
                          {activePoint.item.completed_jobs_count} Job hoàn tất
                        </span>
                        {activePoint.item.failed_jobs_count > 0 && (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300">
                            {activePoint.item.failed_jobs_count} Job lỗi
                          </span>
                        )}
                        {activePoint.item.verified_dbs_count > 0 && (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/25 text-cyan-300">
                            {activePoint.item.verified_dbs_count} DB ✅
                          </span>
                        )}
                        {pinnedDayIdx !== null && (
                          <button
                            type="button"
                            onClick={() => setPinnedDayIdx(null)}
                            className="text-[11px] text-blue-400 hover:text-blue-300 underline"
                          >
                            Bỏ ghim
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 border-t border-slate-800/80 text-[11px]">
                      <div className="flex items-center justify-between sm:block gap-2">
                        <span className="text-slate-400">Thực tốn (Delta): </span>
                        <span className="font-mono font-semibold text-emerald-300">
                          {formatBytes(activePoint.item.physical_delta_bytes)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between sm:block gap-2">
                        <span className="text-slate-400">Dữ liệu bảo vệ (Logical): </span>
                        <span className="font-mono font-semibold text-cyan-300">
                          {formatBytes(activePoint.item.logical_bytes)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between sm:block gap-2">
                        <span className="text-slate-400">Volume NAS đang dùng: </span>
                        <span className="font-mono font-semibold text-slate-200">
                          {formatBytes(activePoint.item.volumes_used_bytes)}
                          {activePoint.item.volumes_total_bytes > 0
                            ? ` / ${formatCompactBytes(
                                activePoint.item.volumes_total_bytes
                              )}`
                            : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Pure Responsive SVG Area + Bar + Polyline Chart */}
                <div className="w-full overflow-hidden rounded-xl bg-slate-950/60 border border-slate-800/80 p-2 sm:p-3">
                  <svg
                    viewBox={`0 0 ${svgW} ${svgH}`}
                    className="w-full h-48 sm:h-56 select-none touch-manipulation"
                    role="img"
                    aria-label="Biểu đồ tăng trưởng dung lượng sao lưu 30 ngày"
                    onMouseLeave={() => setHoveredDayIdx(null)}
                  >
                    <defs>
                      <linearGradient
                        id="nocTrendAreaEmerald"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="0%" stopColor="#10b981" stopOpacity="0.38" />
                        <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
                      </linearGradient>
                      <linearGradient
                        id="nocTrendAreaCyan"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.38" />
                        <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.02" />
                      </linearGradient>
                    </defs>

                    {/* Horizontal Grid Lines & Y-Axis Ticks */}
                    {[0, 0.33, 0.66, 1].map((ratio, idx) => {
                      const yPos = padT + plotH - ratio * plotH;
                      const labelVal = ratio * maxChartVal;
                      return (
                        <g key={idx}>
                          <line
                            x1={padL}
                            y1={yPos}
                            x2={padL + plotW}
                            y2={yPos}
                            stroke="#1e293b"
                            strokeWidth="1"
                            strokeDasharray={ratio === 0 ? undefined : '4 4'}
                          />
                          <text
                            x={padL - 8}
                            y={yPos + 3.5}
                            textAnchor="end"
                            fill="#64748b"
                            fontSize="10"
                            fontFamily="monospace"
                          >
                            {formatCompactBytes(labelVal)}
                          </text>
                        </g>
                      );
                    })}

                    {/* Daily Columns (Subtle Bar Layer) */}
                    {chartPoints.map((pt, idx) => {
                      const barW = Math.max(
                        4,
                        Math.min(18, (plotW / Math.max(historyCount, 1)) * 0.55)
                      );
                      const barVal =
                        chartMode === 'logical' ? pt.deltaVal : pt.val;
                      const barY = getChartY(barVal);
                      const barH = Math.max(2, padT + plotH - barY);
                      const isActive = idx === activeDayIdx;

                      return (
                        <rect
                          key={`bar-${pt.item.stat_date}`}
                          x={pt.x - barW / 2}
                          y={barY}
                          width={barW}
                          height={barH}
                          rx="2.5"
                          fill={
                            chartMode === 'delta'
                              ? isActive
                                ? '#34d399'
                                : '#10b981'
                              : isActive
                              ? '#38bdf8'
                              : '#10b981'
                          }
                          fillOpacity={
                            chartMode === 'logical'
                              ? isActive
                                ? 0.55
                                : 0.28
                              : isActive
                              ? 0.55
                              : 0.22
                          }
                        />
                      );
                    })}

                    {/* Area Fill */}
                    {areaPath && (
                      <path
                        d={areaPath}
                        fill={
                          chartMode === 'delta'
                            ? 'url(#nocTrendAreaEmerald)'
                            : 'url(#nocTrendAreaCyan)'
                        }
                      />
                    )}

                    {/* Primary Polyline */}
                    {chartPoints.length >= 2 && (
                      <polyline
                        fill="none"
                        stroke={chartMode === 'delta' ? '#10b981' : '#22d3ee'}
                        strokeWidth="2.5"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        points={polylinePoints}
                      />
                    )}

                    {/* Active Vertical Crosshair & Highlight Dot */}
                    {activePoint && (
                      <g>
                        <line
                          x1={activePoint.x}
                          y1={padT}
                          x2={activePoint.x}
                          y2={padT + plotH}
                          stroke={chartMode === 'delta' ? '#34d399' : '#38bdf8'}
                          strokeWidth="1.2"
                          strokeDasharray="3 3"
                          strokeOpacity="0.8"
                        />
                        <circle
                          cx={activePoint.x}
                          cy={activePoint.y}
                          r="6.5"
                          fill={chartMode === 'delta' ? '#10b981' : '#22d3ee'}
                          fillOpacity="0.25"
                        />
                        <circle
                          cx={activePoint.x}
                          cy={activePoint.y}
                          r="4"
                          fill="#020617"
                          stroke={chartMode === 'delta' ? '#34d399' : '#67e8f9'}
                          strokeWidth="2.2"
                        />
                      </g>
                    )}

                    {/* X-Axis DD/MM Labels */}
                    {xTickIndices.map((idx) => {
                      const pt = chartPoints[idx];
                      if (!pt) return null;
                      return (
                        <text
                          key={`xtick-${pt.item.stat_date}`}
                          x={pt.x}
                          y={svgH - 7}
                          textAnchor={
                            idx === 0 && historyCount > 1
                              ? 'start'
                              : idx === historyCount - 1 && historyCount > 1
                              ? 'end'
                              : 'middle'
                          }
                          fill={idx === activeDayIdx ? '#e2e8f0' : '#64748b'}
                          fontWeight={idx === activeDayIdx ? '700' : '400'}
                          fontSize="10"
                          fontFamily="monospace"
                        >
                          {formatDayMonth(pt.item.stat_date)}
                        </text>
                      );
                    })}

                    {/* Full-Height Interactive Hover / Tap Hit Slices */}
                    {chartPoints.map((pt, idx) => {
                      const step =
                        historyCount > 1 ? plotW / (historyCount - 1) : plotW;
                      const leftEdge =
                        historyCount <= 1
                          ? padL
                          : idx === 0
                          ? padL
                          : pt.x - step / 2;
                      const rightEdge =
                        historyCount <= 1
                          ? padL + plotW
                          : idx === historyCount - 1
                          ? padL + plotW
                          : pt.x + step / 2;

                      return (
                        <rect
                          key={`hit-${pt.item.stat_date}`}
                          x={leftEdge}
                          y={padT}
                          width={Math.max(12, rightEdge - leftEdge)}
                          height={plotH + padB}
                          fill="transparent"
                          className="cursor-pointer"
                          onMouseEnter={() => setHoveredDayIdx(idx)}
                          onClick={() =>
                            setPinnedDayIdx((prev) =>
                              prev === idx ? null : idx
                            )
                          }
                          onTouchStart={() => setPinnedDayIdx(idx)}
                        />
                      );
                    })}
                  </svg>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
            <span>
              Tổng phát sinh thực tế ({historyCount || 0} ngày):{' '}
              <strong className="text-emerald-300 font-mono">
                {formatBytes(totalDelta30d)}
              </strong>
            </span>
            <span>
              Chạm hoặc di chuột trên biểu đồ để tra cứu chi tiết từng ngày
            </span>
          </div>
        </div>

        {/* Right (xl:col-span-5): Top 10 Largest Domains */}
        <div className="xl:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col justify-between space-y-4 min-w-0">
          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Globe className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>Top 10 Website / Domain Dung lượng Lớn nhất</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tỷ trọng Mã nguồn (Webroot) & Cơ sở dữ liệu (SQL) theo bản sao lưu mới nhất
                </p>
              </div>

              <div className="flex items-center gap-3 text-[11px] text-slate-300 shrink-0">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block" />
                  Webroot
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm bg-cyan-400 inline-block" />
                  SQL DB
                </span>
              </div>
            </div>

            {topDomains.length === 0 ? (
              <div className="py-14 px-4 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl space-y-2">
                <Database className="w-7 h-7 text-slate-600 mx-auto" />
                <div>
                  Chưa có thống kê dung lượng Website / Domain nào.
                </div>
                <div className="text-[11px] text-slate-600">
                  Danh sách Top 10 sẽ tự động xếp hạng sau khi có bản Snapshot hoàn tất.
                </div>
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                {topDomains.map((dom, index) => {
                  const rank = index + 1;
                  const totalBytes = Math.max(
                    0,
                    Number(dom.total_domain_bytes || 0)
                  );
                  const webBytes = Math.max(
                    0,
                    Number(dom.webroot_size_bytes || 0)
                  );
                  const dbBytes = Math.max(0, Number(dom.db_size_bytes || 0));
                  const barScalePct =
                    totalBytes > 0
                      ? Math.max(6, (totalBytes / maxTopDomainBytes) * 100)
                      : 4;
                  const sumParts = Math.max(webBytes + dbBytes, 1);
                  const webWidthPct = (webBytes / sumParts) * barScalePct;
                  const dbWidthPct = (dbBytes / sumParts) * barScalePct;

                  const rankBadgeClass =
                    rank === 1
                      ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                      : rank === 2
                      ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                      : rank === 3
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : 'bg-slate-800 text-slate-400 border-slate-700';

                  return (
                    <div
                      key={`${dom.server_id}-${dom.domain_name}`}
                      className="p-3 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className={`px-1.5 py-0.5 rounded border font-mono text-[10px] font-bold shrink-0 ${rankBadgeClass}`}
                          >
                            #{rank}
                          </span>
                          <span className="font-semibold text-white break-all">
                            {dom.domain_name}
                          </span>
                          {dom.verification_status === 'PASSED' && (
                            <span
                              title="Cơ sở dữ liệu SQL đã kiểm định Sandbox thành công"
                              className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-[10px] font-medium text-emerald-300 shrink-0"
                            >
                              Verified ✅
                            </span>
                          )}
                          {dom.verification_status === 'CORRUPTED' && (
                            <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-[10px] font-medium text-rose-300 shrink-0">
                              SQL Lỗi ❌
                            </span>
                          )}
                        </div>

                        <span className="font-mono font-bold text-white shrink-0">
                          {formatBytes(totalBytes)}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px] text-slate-400">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span className="truncate font-mono text-slate-300">
                            {dom.server_hostname}
                          </span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${getPanelBadgeClass(
                              dom.server_panel
                            )}`}
                          >
                            {dom.server_panel}
                          </span>
                        </div>
                        <span className="text-slate-500 shrink-0">
                          {dom.databases_count} DB
                        </span>
                      </div>

                      {/* Proportional Stacked Bar (Webroot Emerald + SQL DB Cyan) */}
                      <div className="w-full h-2 bg-slate-800/90 rounded-full overflow-hidden flex">
                        {webWidthPct > 0 && (
                          <div
                            className="h-full bg-emerald-500 transition-all duration-300"
                            style={{ width: `${webWidthPct.toFixed(2)}%` }}
                            title={`Webroot: ${formatBytes(webBytes)}`}
                          />
                        )}
                        {dbWidthPct > 0 && (
                          <div
                            className="h-full bg-cyan-400 transition-all duration-300"
                            style={{ width: `${dbWidthPct.toFixed(2)}%` }}
                            title={`SQL DB: ${formatBytes(dbBytes)}`}
                          />
                        )}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-emerald-300/90 font-mono">
                          Webroot: {formatBytes(webBytes)}
                        </span>
                        <span className="text-cyan-300/90 font-mono">
                          SQL DB: {formatBytes(dbBytes)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-[11px] text-slate-400">
            <span>Xếp hạng tự động theo Snapshot hoàn tất mới nhất</span>
            <Link
              href="/explorer"
              className="text-cyan-400 hover:text-cyan-300 font-medium shrink-0"
            >
              Duyệt File →
            </Link>
          </div>
        </div>
      </div>

      {/* Multi-Volume Storage & Quick Trigger */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Multi-Volume Status */}
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-blue-400 shrink-0" />
                <span>Trạng thái Đa Phân vùng Synology NAS (Smart Multi-Volume)</span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Tự động Local Seeding sang Volume kế tiếp khi chạm ngưỡng mà không đứt chuỗi Incremental
              </p>
            </div>
            <Link
              href="/volumes"
              className="text-xs text-blue-400 hover:text-blue-300 font-medium shrink-0 whitespace-nowrap"
            >
              Cấu hình Volume →
            </Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(data?.volumes || []).map((vol) => {
              const pct =
                vol.total_bytes > 0
                  ? Math.min(100, (vol.used_bytes / vol.total_bytes) * 100)
                  : 0;
              const isHigh = pct >= vol.max_usage_percent;

              return (
                <div
                  key={vol.id}
                  className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm text-white flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>{vol.name}</span>
                        <span className="text-[11px] font-normal text-slate-400">
                          (Ưu tiên #{vol.priority})
                        </span>
                      </div>
                      <div className="text-xs font-mono text-slate-400 mt-0.5 break-all">
                        {vol.mount_path}
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 text-[11px] font-semibold rounded border shrink-0 ${
                        vol.status === 'ACTIVE'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : vol.status === 'FULL'
                          ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}
                    >
                      {vol.status}
                    </span>
                  </div>

                  <div>
                    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs mb-1.5">
                      <span className="text-slate-300 font-medium">
                        Đã dùng {pct.toFixed(1)}% ({formatBytes(vol.used_bytes)})
                      </span>
                      <span className="text-slate-400">
                        Trống {formatBytes(vol.free_bytes)}
                      </span>
                    </div>
                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden relative">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          isHigh
                            ? 'bg-rose-500'
                            : pct > 70
                            ? 'bg-amber-500'
                            : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                        }`}
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-slate-500 mt-1.5">
                      <span>Ngưỡng cảnh báo: {vol.max_usage_percent}% (Min {vol.min_free_gb} GB)</span>
                      <span>
                        {vol.btrfs_immutable_enabled === 1
                          ? `Btrfs WORM (${vol.btrfs_retention_days}d) 🔒`
                          : 'Chuẩn POSIX'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Quick Trigger Backup Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Play className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Kích hoạt Sao lưu Nhanh (1-Click)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Chọn máy chủ để chạy ngay phiên Pull Backup về NAS
            </p>
          </div>

          <div className="flex-1 space-y-2.5 overflow-y-auto max-h-60 pr-1">
            {servers.map((srv) => (
              <div
                key={srv.id}
                className="flex items-center justify-between gap-2.5 p-3 rounded-xl bg-slate-950/80 border border-slate-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-white flex items-center gap-1.5 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${
                        srv.status === 'ONLINE'
                          ? 'bg-emerald-400'
                          : srv.status === 'BACKUP_RUNNING'
                          ? 'bg-blue-400 animate-pulse'
                          : 'bg-rose-400'
                      }`}
                    />
                    <span className="truncate">{srv.hostname}</span>
                    {srv.is_mock === 1 && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-300 rounded shrink-0">
                        Demo
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${getPanelBadgeClass(
                        srv.panel_type
                      )}`}
                    >
                      {srv.panel_type}
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono truncate">
                      {srv.ip_address}
                    </span>
                    {srv.host_key_status === 'MISMATCH' && (
                      <Link
                        href="/servers"
                        className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse shrink-0"
                        title="Phát hiện đổi SSH Host Key bất thường — Nhấn để kiểm tra"
                      >
                        🚨 TOFU
                      </Link>
                    )}
                  </div>
                </div>

                {userRole === 'VIEWER' ? (
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-slate-500 italic px-2">
                    Chỉ xem
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void triggerQuickBackup(srv.id)}
                    disabled={
                      startingServerId === srv.id ||
                      srv.status === 'BACKUP_RUNNING' ||
                      srv.host_key_status === 'MISMATCH'
                    }
                    title={
                      srv.host_key_status === 'MISMATCH'
                        ? 'Đã khóa kết nối do lệch SSH Host Key TOFU — Vui lòng xác minh tại trang Máy chủ VPS'
                        : undefined
                    }
                    className="shrink-0 whitespace-nowrap min-h-[38px] px-3.5 inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 disabled:opacity-50 transition-all"
                  >
                    <Play className="w-3 h-3 fill-current shrink-0" />
                    {srv.status === 'BACKUP_RUNNING' ? 'Đang chạy' : 'Sao lưu'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Live Progress & Live Terminal Console */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Progress */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-blue-400 shrink-0" />
              <span>Tiến trình Đang thực thi Thời gian thực (WebSocket)</span>
            </h3>
            <Link
              href="/jobs"
              className="text-xs text-blue-400 hover:text-blue-300 shrink-0 whitespace-nowrap"
            >
              Tất cả lịch sử →
            </Link>
          </div>

          {activeJobs.length === 0 ? (
            <div className="py-10 px-4 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
              Hiện không có tiến trình nào đang chạy. Hãy nhấn nút{' '}
              <strong className="text-slate-300">Sao lưu</strong> ở khung bên trên để xem trực tiếp thanh tiến trình & Live Terminal!
            </div>
          ) : (
            <div className="space-y-3">
              {activeJobs.map((j) => {
                const live = progressMap[j.id];
                const pct = live?.progressPercent ?? j.progress_percent;
                const phase = live?.currentPhase ?? j.current_phase;
                const dom = live?.currentDomain ?? j.current_domain;
                const speed = live?.speedBps ?? j.speed_bps;
                const eta = live?.etaSeconds ?? j.eta_seconds;
                const retries = live?.retryCount ?? j.retry_count;
                const st = getJobStatusMeta(live?.status ?? j.status);

                return (
                  <div
                    key={j.id}
                    className="p-3.5 sm:p-4 rounded-xl bg-slate-950 border border-blue-500/30 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold text-sm text-white flex flex-wrap items-center gap-1.5 min-w-0">
                        <span>#{j.id}</span>
                        <span className="break-all">{j.server_hostname}</span>
                        {dom && (
                          <span className="text-xs font-mono text-cyan-400 break-all">
                            ({dom})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {retries > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
                            Retry #{retries}
                          </span>
                        )}
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded border shrink-0 ${st.className}`}
                        >
                          {st.label}
                        </span>
                      </div>
                    </div>

                    <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-blue-500 to-emerald-400 transition-all duration-300"
                        style={{ width: `${Math.max(4, pct)}%` }}
                      />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs text-slate-400">
                      <span className="break-words">{phase}</span>
                      <span className="shrink-0 font-mono text-slate-300">
                        {pct}% • {formatSpeed(speed)} • ETA {formatEta(eta)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Live Terminal Stream */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2 min-w-0">
              <Terminal className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="truncate">
                Live Worker Terminal Log (Rsync / SSH Stream / Sandbox)
              </span>
            </h3>
            <button
              type="button"
              onClick={clearLogs}
              className="text-[11px] text-slate-400 hover:text-white shrink-0 whitespace-nowrap"
            >
              Xóa màn hình
            </button>
          </div>

          <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-3.5 font-mono text-xs h-56 overflow-y-auto space-y-1">
            {liveLogs.length === 0 ? (
              <div className="text-slate-600 break-words">
                nas-sync-worker@synology-nas:~$ Đang lắng nghe luồng sự kiện thời gian thực từ Worker...
              </div>
            ) : (
              liveLogs.map((item, i) => (
                <div key={i} className="text-slate-300 leading-relaxed break-all">
                  <span className="text-blue-400">[{item.hostname}]</span>{' '}
                  <span>{item.line}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Recent Jobs Table & Recent Alerts */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-white">
              Phiên Sao lưu & Khôi phục Gần đây
            </h3>
            <Link
              href="/explorer"
              className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 shrink-0"
            >
              <FolderGit2 className="w-3.5 h-3.5 shrink-0" />
              Mở File Explorer & Diff Viewer
            </Link>
          </div>

          {/* Mobile Card List (< md) */}
          <div className="md:hidden divide-y divide-slate-800/70">
            {(data?.recentJobs || []).length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                Chưa có phiên sao lưu hoặc khôi phục nào gần đây.
              </div>
            ) : (
              (data?.recentJobs || []).slice(0, 8).map((job) => {
                const st = getJobStatusMeta(
                  progressMap[job.id]?.status || job.status
                );
                return (
                  <div key={job.id} className="py-3.5 first:pt-0 last:pb-0 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-white flex flex-wrap items-center gap-1.5">
                          <span>#{job.id}</span>
                          <span className="break-all">{job.server_hostname}</span>
                          {job.is_pinned === 1 && (
                            <span title="Đã khóa bảo vệ Pinned">📌</span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {job.job_type === 'RESTORE'
                            ? `Restore ➔ ${job.target_server_hostname || ''}`
                            : `Backup (${job.server_panel})`}
                          {job.volume_name ? ` • ${job.volume_name}` : ''}
                        </div>
                      </div>
                      <span
                        className={`inline-block px-2 py-0.5 rounded border text-[11px] shrink-0 ${st.className}`}
                      >
                        {st.label}
                      </span>
                    </div>

                    <div className="font-mono text-[11px] text-slate-300 break-all bg-slate-950/70 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                      {job.snapshot_name}
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-slate-200 font-medium">
                          {formatBytes(job.total_size_bytes)}
                        </span>
                        <span className="text-emerald-400">
                          +{formatBytes(job.delta_size_bytes)}
                        </span>
                        <span className="text-slate-500">
                          • {formatDateTime(job.completed_at || job.created_at)}
                        </span>
                      </div>
                      <Link
                        href="/jobs"
                        className="text-blue-400 hover:text-blue-300 font-medium shrink-0"
                      >
                        Chi tiết →
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop/Tablet Table (>= md) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-800">
                  <th className="pb-2.5 font-medium">Job / Máy chủ</th>
                  <th className="pb-2.5 font-medium">Snapshot</th>
                  <th className="pb-2.5 font-medium">Phân vùng</th>
                  <th className="pb-2.5 font-medium">Tổng / Delta</th>
                  <th className="pb-2.5 font-medium">Trạng thái</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {(data?.recentJobs || []).slice(0, 8).map((job) => {
                  const st = getJobStatusMeta(
                    progressMap[job.id]?.status || job.status
                  );
                  return (
                    <tr key={job.id} className="hover:bg-slate-800/30">
                      <td className="py-3 pr-3">
                        <div className="font-medium text-white flex items-center gap-1.5">
                          <span>#{job.id}</span>
                          <span>{job.server_hostname}</span>
                          {job.is_pinned === 1 && (
                            <span title="Đã khóa bảo vệ Pinned">📌</span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {job.job_type === 'RESTORE'
                            ? `Restore ➔ ${job.target_server_hostname || ''}`
                            : `Backup (${job.server_panel})`}
                        </div>
                      </td>
                      <td className="py-3 pr-3 font-mono text-slate-300">
                        {job.snapshot_name}
                      </td>
                      <td className="py-3 pr-3 text-slate-400">
                        {job.volume_name || '—'}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="text-slate-200">
                          {formatBytes(job.total_size_bytes)}
                        </div>
                        <div className="text-[11px] text-emerald-400">
                          +{formatBytes(job.delta_size_bytes)}
                        </div>
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded border text-[11px] ${st.className}`}
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

        {/* Alerts */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Nhật ký Cảnh báo Hệ thống</span>
            </h3>
            <Link
              href="/alerts"
              className="text-xs text-cyan-400 hover:text-cyan-300 font-medium shrink-0"
            >
              Xem tất cả →
            </Link>
          </div>

          <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
            {(data?.recentAlerts || []).length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                Hệ thống hoạt động ổn định, không có cảnh báo bất thường.
              </div>
            ) : (
              (data?.recentAlerts || []).map((al) => (
                <div
                  key={al.id}
                  className={`p-3 rounded-xl border text-xs space-y-1 ${
                    al.severity === 'CRITICAL'
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                      : al.severity === 'WARNING'
                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                      : 'bg-slate-950 border-slate-800 text-slate-300'
                  }`}
                >
                  <div className="font-semibold flex items-start justify-between gap-2">
                    <span className="break-words min-w-0">{al.title}</span>
                    <span className="text-[10px] opacity-75 shrink-0">
                      {al.category}
                    </span>
                  </div>
                  <p className="text-[11px] opacity-85 line-clamp-3 break-words">
                    {al.message}
                  </p>
                  <div className="text-[10px] opacity-60">
                    {formatDateTime(al.created_at)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


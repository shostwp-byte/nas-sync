'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
  Download,
  Eye,
  FolderGit2,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  StopCircle,
  Trash2,
  X,
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
import type { BackupItem, BackupJob, ServerRecord, UserRole } from '@/types';

interface ExtendedJob extends BackupJob {
  domains_count?: number;
  verified_domains_count?: number;
}

export default function JobsPage() {
  const { progressMap, lastUpdateCounter } = useRealtime();
  const [jobs, setJobs] = useState<ExtendedJob[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [filterServer, setFilterServer] = useState('');
  const [filterType, setFilterType] = useState('');
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<UserRole>('ADMIN');

  const [selectedJob, setSelectedJob] = useState<ExtendedJob | null>(null);
  const [jobItems, setJobItems] = useState<BackupItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Offsite Cloud 3-2-1 Push State
  const [pushingOffsiteJobId, setPushingOffsiteJobId] = useState<number | null>(
    null
  );
  const [offsiteFeedback, setOffsiteFeedback] = useState<{
    jobId: number;
    ok: boolean;
    text: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data?.user?.role) {
          setUserRole(data.user.role as UserRole);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (filterServer) qs.set('serverId', filterServer);
      if (filterType) qs.set('jobType', filterType);
      const [jRes, sRes] = await Promise.all([
        fetch(`/api/jobs?${qs.toString()}`),
        fetch('/api/servers'),
      ]);
      if (jRes.ok) setJobs((await jRes.json()).jobs || []);
      if (sRes.ok) setServers((await sRes.json()).servers || []);
    } finally {
      setLoading(false);
    }
  }, [filterServer, filterType]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs, lastUpdateCounter]);

  const openJobDetail = async (job: ExtendedJob) => {
    setSelectedJob(job);
    setDetailLoading(true);
    try {
      const resp = await fetch(`/api/jobs/${job.id}`);
      if (resp.ok) {
        const json = await resp.json();
        setSelectedJob(json.job);
        setJobItems(json.items || []);
      }
    } finally {
      setDetailLoading(false);
    }
  };

  const runJobAction = async (
    jobId: number,
    action: 'pin' | 'unpin' | 'cancel' | 'retry' | 'verify_sandbox'
  ) => {
    const resp = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      alert(json.error || 'Thao tác thất bại');
      return;
    }
    await loadJobs();
    if (selectedJob && selectedJob.id === jobId) {
      await openJobDetail(selectedJob);
    }
  };

  const deleteJob = async (job: ExtendedJob) => {
    if (
      !confirm(
        `Xóa vĩnh viễn Snapshot ${job.snapshot_name} của ${job.server_hostname}?`
      )
    )
      return;
    const resp = await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' });
    const json = await resp.json();
    if (!resp.ok) {
      alert(json.error || 'Không thể xóa bản sao lưu');
      return;
    }
    setSelectedJob(null);
    await loadJobs();
  };

  const handlePushOffsite = async (job: ExtendedJob) => {
    setPushingOffsiteJobId(job.id);
    setOffsiteFeedback(null);
    try {
      const resp = await fetch('/api/offsite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'push_snapshot', jobId: job.id }),
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok || json.ok === false) {
        const errMsg =
          json.error ||
          'Chưa cấu hình Đám mây Offsite 3-2-1. Vui lòng thiết lập Google Drive hoặc S3 tại mục Cài đặt Hệ thống trước khi đẩy bản sao lưu.';
        setOffsiteFeedback({
          jobId: job.id,
          ok: false,
          text: errMsg,
        });
        return;
      }
      setOffsiteFeedback({
        jobId: job.id,
        ok: true,
        text:
          json.message ||
          'Đã khởi chạy mã hóa AES-256-GCM và đẩy bản sao lưu lên Đám mây Offsite 3-2-1!',
      });
    } catch (err) {
      setOffsiteFeedback({
        jobId: job.id,
        ok: false,
        text:
          (err as Error).message ||
          'Lỗi kết nối khi đẩy bản sao lưu lên Đám mây Offsite 3-2-1.',
      });
    } finally {
      setPushingOffsiteJobId(null);
    }
  };

  const canPushOffsiteRole = userRole === 'ADMIN' || userRole === 'OPERATOR';

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400 shrink-0" />
            <span>Tiến trình & Lịch sử Sao lưu / Khôi phục</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Theo dõi thời gian thực %, tốc độ truyền tải, trạng thái Auto-Resume, khóa Pin bảo vệ bản sạch và kết quả kiểm định SQL Sandbox.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto text-xs">
          <select
            value={filterServer}
            onChange={(e) => setFilterServer(e.target.value)}
            className="flex-1 sm:flex-initial min-w-[140px] min-h-[40px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200"
          >
            <option value="">Tất cả máy chủ VPS</option>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.hostname}
              </option>
            ))}
          </select>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="flex-1 sm:flex-initial min-w-[140px] min-h-[40px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200"
          >
            <option value="">Tất cả loại Job</option>
            <option value="BACKUP">Sao lưu (BACKUP)</option>
            <option value="RESTORE">Khôi phục (RESTORE)</option>
          </select>

          <button
            type="button"
            onClick={() => void loadJobs()}
            className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 whitespace-nowrap transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            Làm mới
          </button>
        </div>
      </div>

      {!selectedJob && offsiteFeedback && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-start justify-between gap-3 ${
            offsiteFeedback.ok
              ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
              : 'bg-rose-500/15 border-rose-500/35 text-rose-200'
          }`}
        >
          <div className="min-w-0 break-words space-y-1">
            <div>
              {offsiteFeedback.ok ? '✅ ' : '❌ '}
              {offsiteFeedback.text}
            </div>
            {!offsiteFeedback.ok && userRole === 'ADMIN' && (
              <div>
                <Link
                  href="/settings"
                  className="text-cyan-300 hover:underline font-semibold"
                >
                  → Mở Cài đặt Hệ thống để thiết lập Đám mây Offsite 3-2-1
                </Link>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setOffsiteFeedback(null)}
            aria-label="Đóng thông báo"
            className="text-slate-400 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        {/* Mobile & Tablet Job Cards (< lg) */}
        <div className="lg:hidden divide-y divide-slate-800/80">
          {loading ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Đang tải danh sách tiến trình...
            </div>
          ) : jobs.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Chưa có lịch sử tiến trình nào.
            </div>
          ) : (
            jobs.map((job) => {
              const live = progressMap[job.id];
              const status = live?.status || job.status;
              const pct = live?.progressPercent ?? job.progress_percent;
              const phase = live?.currentPhase ?? job.current_phase;
              const speed = live?.speedBps ?? job.speed_bps;
              const eta = live?.etaSeconds ?? job.eta_seconds;
              const st = getJobStatusMeta(status);

              return (
                <div key={job.id} className="p-4 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-bold text-sm text-white">#{job.id}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${getPanelBadgeClass(
                          job.server_panel
                        )}`}
                      >
                        {job.job_type === 'RESTORE' ? 'RESTORE' : job.job_type}
                      </span>
                      {job.is_pinned === 1 && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          📌 Pinned
                        </span>
                      )}
                      {job.anomaly_detected === 1 && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                          ⚠️ Anomaly
                        </span>
                      )}
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded border text-[11px] font-medium shrink-0 ${st.className}`}
                    >
                      {st.label}
                    </span>
                  </div>

                  <div className="space-y-1">
                    <div className="font-semibold text-sm text-white break-all">
                      {job.server_hostname}
                      {job.job_type === 'RESTORE' && job.target_server_hostname ? (
                        <span className="text-cyan-400 font-normal">
                          {' '}
                          ➔ {job.target_server_hostname}
                        </span>
                      ) : null}
                    </div>
                    <div className="font-mono text-[11px] text-slate-300 break-all">
                      {job.snapshot_name}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {job.volume_name ? `${job.volume_name} • ` : ''}
                      {formatDateTime(job.completed_at || job.created_at)}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          status === 'FAILED'
                            ? 'bg-rose-500'
                            : status === 'COMPLETED'
                            ? 'bg-emerald-500'
                            : 'bg-blue-500'
                        }`}
                        style={{ width: `${Math.max(3, pct)}%` }}
                      />
                    </div>
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-[11px] text-slate-400">
                      <span className="break-words">{phase}</span>
                      <span className="font-mono text-slate-300 shrink-0">
                        {pct}%
                        {speed > 0
                          ? ` • ${formatSpeed(speed)} (ETA ${formatEta(eta)})`
                          : ''}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] bg-slate-950/70 border border-slate-800/80 rounded-xl px-3 py-2">
                    <div>
                      <span className="text-slate-200 font-medium">
                        {formatBytes(job.total_size_bytes)}
                      </span>
                      <span className="text-emerald-400 ml-2">
                        Delta: +{formatBytes(job.delta_size_bytes)}
                      </span>
                    </div>
                    {job.job_type === 'BACKUP' && status === 'COMPLETED' && (
                      <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        {job.verified_domains_count || 0}/{job.domains_count || 0}{' '}
                        Verified ✅
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/70">
                    <button
                      type="button"
                      onClick={() => void openJobDetail(job)}
                      className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                    >
                      <Eye className="w-3.5 h-3.5 shrink-0" />
                      Chi tiết & Log
                    </button>

                    {job.job_type === 'BACKUP' && status === 'COMPLETED' && (
                      <>
                        <Link
                          href={`/explorer?jobId=${job.id}`}
                          className="min-h-[38px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700"
                        >
                          <FolderGit2 className="w-3.5 h-3.5 shrink-0" />
                          Explorer
                        </Link>
                        {canPushOffsiteRole && (
                          <button
                            type="button"
                            disabled={pushingOffsiteJobId === job.id}
                            onClick={() => void handlePushOffsite(job)}
                            className="min-h-[38px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/35 font-medium disabled:opacity-50 transition-colors"
                          >
                            {pushingOffsiteJobId === job.id ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                                <span>Đang đẩy Offsite...</span>
                              </>
                            ) : (
                              <span>☁️ Đẩy Offsite 3-2-1</span>
                            )}
                          </button>
                        )}
                      </>
                    )}

                    {userRole !== 'VIEWER' && (
                      <>
                        {['RUNNING', 'QUEUED', 'RESUMING'].includes(status) && (
                          <button
                            type="button"
                            onClick={() => void runJobAction(job.id, 'cancel')}
                            className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white border border-rose-500/30"
                          >
                            <StopCircle className="w-3.5 h-3.5 shrink-0" />
                            Hủy
                          </button>
                        )}

                        {['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(
                          status
                        ) && (
                          <button
                            type="button"
                            onClick={() => void runJobAction(job.id, 'retry')}
                            className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-slate-950 border border-amber-500/30"
                          >
                            <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                            Retry
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() =>
                            void runJobAction(
                              job.id,
                              job.is_pinned === 1 ? 'unpin' : 'pin'
                            )
                          }
                          aria-label={
                            job.is_pinned === 1
                              ? 'Bỏ khóa Pin'
                              : 'Khóa Pin chống xóa GFS'
                          }
                          className={`min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border ${
                            job.is_pinned === 1
                              ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                              : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                          }`}
                        >
                          {job.is_pinned === 1 ? (
                            <>
                              <PinOff className="w-3.5 h-3.5 shrink-0" />
                              <span>Bỏ ghim</span>
                            </>
                          ) : (
                            <>
                              <Pin className="w-3.5 h-3.5 shrink-0" />
                              <span>Ghim</span>
                            </>
                          )}
                        </button>
                      </>
                    )}

                    {userRole === 'ADMIN' && (
                      <button
                        type="button"
                        onClick={() => void deleteJob(job)}
                        aria-label={`Xóa bản sao lưu ${job.snapshot_name}`}
                        className="ml-auto min-h-[38px] min-w-[38px] p-2 inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 border border-slate-700/80"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop Table (>= lg) */}
        <div className="hidden lg:block overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead>
              <tr className="bg-slate-950/70 text-slate-400 border-b border-slate-800">
                <th className="p-4 font-medium">ID / Máy chủ</th>
                <th className="p-4 font-medium">Snapshot</th>
                <th className="p-4 font-medium">Tiến trình Realtime</th>
                <th className="p-4 font-medium">Dung lượng / Delta</th>
                <th className="p-4 font-medium">Kiểm định SQL</th>
                <th className="p-4 font-medium">Trạng thái</th>
                <th className="p-4 font-medium text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    Đang tải danh sách tiến trình...
                  </td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    Chưa có lịch sử tiến trình nào.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => {
                  const live = progressMap[job.id];
                  const status = live?.status || job.status;
                  const pct = live?.progressPercent ?? job.progress_percent;
                  const phase = live?.currentPhase ?? job.current_phase;
                  const speed = live?.speedBps ?? job.speed_bps;
                  const eta = live?.etaSeconds ?? job.eta_seconds;
                  const st = getJobStatusMeta(status);

                  return (
                    <tr key={job.id} className="hover:bg-slate-800/30">
                      <td className="p-4">
                        <div className="font-semibold text-white flex items-center gap-1.5">
                          <span>#{job.id}</span>
                          <span>{job.server_hostname}</span>
                          {job.is_pinned === 1 && (
                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                              📌 Pinned
                            </span>
                          )}
                          {job.anomaly_detected === 1 && (
                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-rose-500/20 text-rose-300 border border-rose-500/30">
                              ⚠️ Anomaly
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${getPanelBadgeClass(
                              job.server_panel
                            )}`}
                          >
                            {job.job_type === 'RESTORE'
                              ? `RESTORE ➔ ${job.target_server_hostname || ''}`
                              : job.server_panel}
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {job.volume_name || ''}
                          </span>
                        </div>
                      </td>

                      <td className="p-4 font-mono text-slate-300">
                        <div>{job.snapshot_name}</div>
                        <div className="text-[11px] text-slate-500 font-sans">
                          {formatDateTime(job.completed_at || job.created_at)}
                        </div>
                      </td>

                      <td className="p-4 min-w-[220px]">
                        <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden mb-1.5">
                          <div
                            className={`h-full transition-all duration-300 ${
                              status === 'FAILED'
                                ? 'bg-rose-500'
                                : status === 'COMPLETED'
                                ? 'bg-emerald-500'
                                : 'bg-blue-500'
                            }`}
                            style={{ width: `${Math.max(3, pct)}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-slate-400">
                          <span className="truncate max-w-[150px]">{phase}</span>
                          <span className="font-mono text-slate-300">
                            {pct}%
                            {speed > 0
                              ? ` • ${formatSpeed(speed)} (${formatEta(eta)})`
                              : ''}
                          </span>
                        </div>
                      </td>

                      <td className="p-4">
                        <div className="text-slate-200 font-medium">
                          {formatBytes(job.total_size_bytes)}
                        </div>
                        <div className="text-[11px] text-emerald-400">
                          Delta: +{formatBytes(job.delta_size_bytes)}
                        </div>
                      </td>

                      <td className="p-4">
                        {job.job_type === 'BACKUP' && status === 'COMPLETED' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {job.verified_domains_count || 0}/
                            {job.domains_count || 0} Verified ✅
                          </span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>

                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded border text-[11px] font-medium ${st.className}`}
                        >
                          {st.label}
                        </span>
                      </td>

                      <td className="p-4">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => void openJobDetail(job)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            Chi tiết
                          </button>

                          {job.job_type === 'BACKUP' &&
                            status === 'COMPLETED' && (
                              <>
                                <Link
                                  href={`/explorer?jobId=${job.id}`}
                                  title="Mở File Explorer & Diff Viewer"
                                  className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700"
                                >
                                  <FolderGit2 className="w-3.5 h-3.5" />
                                </Link>
                                {canPushOffsiteRole && (
                                  <button
                                    type="button"
                                    disabled={pushingOffsiteJobId === job.id}
                                    onClick={() => void handlePushOffsite(job)}
                                    title="Mã hóa AES-256-GCM và đẩy bản sao lưu lên Đám mây Offsite 3-2-1"
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/35 font-medium whitespace-nowrap disabled:opacity-50 transition-colors"
                                  >
                                    {pushingOffsiteJobId === job.id ? (
                                      <>
                                        <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                                        <span>Đang đẩy...</span>
                                      </>
                                    ) : (
                                      <span>☁️ Đẩy Offsite 3-2-1</span>
                                    )}
                                  </button>
                                )}
                              </>
                            )}

                          {userRole !== 'VIEWER' && (
                            <>
                              {['RUNNING', 'QUEUED', 'RESUMING'].includes(
                                status
                              ) && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runJobAction(job.id, 'cancel')
                                  }
                                  title="Hủy tiến trình"
                                  className="p-1.5 rounded-lg bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white"
                                >
                                  <StopCircle className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(
                                status
                              ) && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runJobAction(job.id, 'retry')
                                  }
                                  title="Thử lại / Nối tiếp Auto-Resume"
                                  className="p-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-slate-950"
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() =>
                                  void runJobAction(
                                    job.id,
                                    job.is_pinned === 1 ? 'unpin' : 'pin'
                                  )
                                }
                                title={
                                  job.is_pinned === 1
                                    ? 'Bỏ khóa Pin'
                                    : 'Khóa Pin chống xóa GFS'
                                }
                                className={`p-1.5 rounded-lg border ${
                                  job.is_pinned === 1
                                    ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
                                }`}
                              >
                                {job.is_pinned === 1 ? (
                                  <PinOff className="w-3.5 h-3.5" />
                                ) : (
                                  <Pin className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </>
                          )}

                          {userRole === 'ADMIN' && (
                            <button
                              type="button"
                              onClick={() => void deleteJob(job)}
                              title="Xóa bản sao lưu"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
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

      {/* Job Details Modal */}
      {selectedJob && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full p-4 sm:p-6 gap-4 max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3 shrink-0">
              <div className="min-w-0">
                <h3 className="text-sm sm:text-base font-bold text-white break-words">
                  Chi tiết Job #{selectedJob.id} — {selectedJob.server_hostname}{' '}
                  <span className="font-mono text-cyan-300 break-all">
                    ({selectedJob.snapshot_name})
                  </span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 break-all">
                  Phân vùng: {selectedJob.volume_name} (
                  {selectedJob.volume_mount_path}) • Tổng file:{' '}
                  {selectedJob.files_total} (Đổi: {selectedJob.files_changed})
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {selectedJob.job_type === 'BACKUP' &&
                  (progressMap[selectedJob.id]?.status ||
                    selectedJob.status) === 'COMPLETED' &&
                  canPushOffsiteRole && (
                    <button
                      type="button"
                      disabled={pushingOffsiteJobId === selectedJob.id}
                      onClick={() => void handlePushOffsite(selectedJob)}
                      className="hidden sm:inline-flex min-h-[38px] items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/35 whitespace-nowrap disabled:opacity-50 transition-colors"
                    >
                      {pushingOffsiteJobId === selectedJob.id ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                          <span>Đang đẩy Offsite...</span>
                        </>
                      ) : (
                        <span>☁️ Đẩy Offsite 3-2-1</span>
                      )}
                    </button>
                  )}
                <button
                  type="button"
                  onClick={() => setSelectedJob(null)}
                  aria-label="Đóng"
                  className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {selectedJob.job_type === 'BACKUP' &&
              (progressMap[selectedJob.id]?.status || selectedJob.status) ===
                'COMPLETED' &&
              canPushOffsiteRole && (
                <div className="sm:hidden shrink-0">
                  <button
                    type="button"
                    disabled={pushingOffsiteJobId === selectedJob.id}
                    onClick={() => void handlePushOffsite(selectedJob)}
                    className="w-full min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/35 disabled:opacity-50 transition-colors"
                  >
                    {pushingOffsiteJobId === selectedJob.id ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span>Đang đẩy Offsite...</span>
                      </>
                    ) : (
                      <span>☁️ Đẩy Offsite 3-2-1</span>
                    )}
                  </button>
                </div>
              )}

            <div className="flex-1 overflow-y-auto space-y-5 min-h-0 pr-0.5">
              {offsiteFeedback && offsiteFeedback.jobId === selectedJob.id && (
                <div
                  className={`p-3.5 rounded-xl border text-xs flex items-start justify-between gap-3 ${
                    offsiteFeedback.ok
                      ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-200'
                      : 'bg-rose-500/15 border-rose-500/35 text-rose-200'
                  }`}
                >
                  <div className="min-w-0 break-words space-y-1">
                    <div>
                      {offsiteFeedback.ok ? '✅ ' : '❌ '}
                      {offsiteFeedback.text}
                    </div>
                    {!offsiteFeedback.ok && userRole === 'ADMIN' && (
                      <div>
                        <Link
                          href="/settings"
                          className="text-cyan-300 hover:underline font-semibold"
                        >
                          → Mở Cài đặt Hệ thống để thiết lập Đám mây Offsite 3-2-1
                        </Link>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOffsiteFeedback(null)}
                    aria-label="Đóng thông báo"
                    className="text-slate-400 hover:text-white shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {selectedJob.anomaly_detected === 1 && (
                <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-xs text-rose-200 break-words">
                  🚨 <strong>Cảnh báo Bất thường (Anomaly Detection):</strong>{' '}
                  {selectedJob.anomaly_reason}
                </div>
              )}

              {detailLoading ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  Đang tải danh sách Domain & Nhật ký phiên chạy...
                </div>
              ) : (
                <>
                  {jobItems.length > 0 && (
                    <div className="space-y-2.5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <h4 className="text-xs font-semibold text-slate-200">
                          Danh sách Website & Database trong Snapshot (
                          {jobItems.length} domains)
                        </h4>
                        {userRole !== 'VIEWER' && (
                          <button
                            type="button"
                            onClick={() =>
                              void runJobAction(
                                selectedJob.id,
                                'verify_sandbox'
                              )
                            }
                            className="w-full sm:w-auto justify-center min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-violet-600/20 hover:bg-violet-600 text-violet-300 hover:text-white border border-violet-500/30 transition-colors"
                          >
                            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                            Chạy Kiểm thử SQL Sandbox Ngay
                          </button>
                        )}
                      </div>

                      <div className="border border-slate-800 rounded-xl overflow-hidden">
                        {/* Mobile Domain Card List (< md) */}
                        <div className="md:hidden divide-y divide-slate-800">
                          {jobItems.map((it) => (
                            <div
                              key={it.id}
                              className="p-3.5 space-y-2.5 text-xs bg-slate-950/40"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="font-semibold text-white flex flex-wrap items-center gap-1.5">
                                    <span className="break-all">
                                      {it.domain_name}
                                    </span>
                                    {it.is_subdomain === 1 && (
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium shrink-0">
                                        SUB
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                                    User: {it.system_user} • {it.php_version}
                                  </div>
                                  {it.source_webroot && (
                                    <div className="text-[11px] font-mono text-slate-500 break-all mt-0.5">
                                      {it.source_webroot}
                                    </div>
                                  )}
                                </div>

                                <div className="shrink-0">
                                  {it.verification_status === 'PASSED' ? (
                                    <span
                                      title={it.verification_detail || ''}
                                      className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] whitespace-nowrap"
                                    >
                                      Verified ✅
                                    </span>
                                  ) : it.verification_status === 'CORRUPTED' ? (
                                    <span className="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] whitespace-nowrap">
                                      Corrupted ❌
                                    </span>
                                  ) : (
                                    <span className="text-[11px] text-slate-500 whitespace-nowrap">
                                      Chưa kiểm tra
                                    </span>
                                  )}
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] bg-slate-950 border border-slate-800/80 rounded-lg px-2.5 py-1.5">
                                <span className="text-slate-300">
                                  Mã nguồn:{' '}
                                  <strong className="text-white">
                                    {formatBytes(it.webroot_size_bytes)}
                                  </strong>
                                </span>
                                <div className="flex flex-wrap items-center gap-1.5 font-mono text-cyan-300">
                                  {it.databases_list.length === 0 ? (
                                    <span>Không dùng DB</span>
                                  ) : (
                                    it.databases_list.map((d) => {
                                      const isPg =
                                        d.engine === 'POSTGRESQL' ||
                                        Boolean(d.file?.startsWith('pg_'));
                                      return (
                                        <span
                                          key={d.name}
                                          className="inline-flex items-center gap-1 break-all"
                                        >
                                          <span>
                                            {d.name} ({formatBytes(d.size_bytes)})
                                          </span>
                                          {isPg && (
                                            <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/35 text-[10px] font-sans font-semibold shrink-0">
                                              PostgreSQL
                                            </span>
                                          )}
                                        </span>
                                      );
                                    })
                                  )}
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <a
                                  href={`/api/explorer/archive?jobId=${selectedJob.id}&domain=${encodeURIComponent(
                                    it.domain_name
                                  )}`}
                                  title={`Tải trọn gói website ${it.domain_name} (.tar.gz)`}
                                  className="flex-1 min-h-[38px] px-3 py-1.5 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 font-semibold whitespace-nowrap transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5 shrink-0" />
                                  <span>Tải .tar.gz</span>
                                </a>
                                {userRole !== 'VIEWER' && (
                                  <Link
                                    href={`/restore?itemId=${it.id}`}
                                    className="flex-1 min-h-[38px] px-3 py-1.5 inline-flex items-center justify-center rounded-lg bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 font-semibold whitespace-nowrap transition-colors"
                                  >
                                    Restore →
                                  </Link>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Tablet/Desktop Table (>= md) */}
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full min-w-[680px] text-left text-xs">
                            <thead className="bg-slate-950 text-slate-400">
                              <tr>
                                <th className="p-3">Domain / System User</th>
                                <th className="p-3">Mã nguồn</th>
                                <th className="p-3">Databases (MySQL / PostgreSQL)</th>
                                <th className="p-3">Trạng thái Sandbox</th>
                                <th className="p-3 text-right">
                                  Tải gói / Khôi phục
                                </th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {jobItems.map((it) => (
                                <tr key={it.id}>
                                  <td className="p-3">
                                    <div className="font-semibold text-white flex items-center gap-1.5 flex-wrap">
                                      <span>{it.domain_name}</span>
                                      {it.is_subdomain === 1 && (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium">
                                          SUB
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-[11px] font-mono text-slate-400">
                                      User: {it.system_user} • {it.php_version}
                                    </div>
                                  </td>
                                  <td className="p-3 text-slate-300 whitespace-nowrap">
                                    {formatBytes(it.webroot_size_bytes)}
                                  </td>
                                  <td className="p-3 font-mono text-[11px] text-cyan-300">
                                    {it.databases_list.length === 0 ? (
                                      <span className="text-slate-500 font-sans">
                                        Không dùng DB
                                      </span>
                                    ) : (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        {it.databases_list.map((d) => {
                                          const isPg =
                                            d.engine === 'POSTGRESQL' ||
                                            Boolean(d.file?.startsWith('pg_'));
                                          return (
                                            <span
                                              key={d.name}
                                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-950 border border-slate-800"
                                            >
                                              <span>
                                                {d.name} ({formatBytes(d.size_bytes)})
                                              </span>
                                              {isPg && (
                                                <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/35 text-[10px] font-sans font-semibold">
                                                  PostgreSQL
                                                </span>
                                              )}
                                            </span>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </td>
                                  <td className="p-3 whitespace-nowrap">
                                    {it.verification_status === 'PASSED' ? (
                                      <span
                                        title={it.verification_detail || ''}
                                        className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px]"
                                      >
                                        Verified ✅
                                      </span>
                                    ) : it.verification_status === 'CORRUPTED' ? (
                                      <span className="px-2 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px]">
                                        Corrupted ❌
                                      </span>
                                    ) : (
                                      <span className="text-slate-500">
                                        Chưa kiểm tra
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-3 text-right whitespace-nowrap">
                                    <div className="inline-flex items-center justify-end gap-1.5">
                                      <a
                                        href={`/api/explorer/archive?jobId=${selectedJob.id}&domain=${encodeURIComponent(
                                          it.domain_name
                                        )}`}
                                        title={`Tải trọn gói website ${it.domain_name} (.tar.gz)`}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 transition-colors"
                                      >
                                        <Download className="w-3 h-3 shrink-0" />
                                        <span>Tải .tar.gz</span>
                                      </a>
                                      {userRole !== 'VIEWER' && (
                                        <Link
                                          href={`/restore?itemId=${it.id}`}
                                          className="inline-flex items-center px-2.5 py-1 rounded bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30 transition-colors"
                                        >
                                          Restore
                                        </Link>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-slate-200">
                      Nhật ký Thực thi Chi tiết (Worker Execution Log)
                    </h4>
                    <pre className="bg-slate-950 border border-slate-800 rounded-xl p-3.5 sm:p-4 font-mono text-xs text-slate-300 max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
                      {selectedJob.live_log ||
                        selectedJob.error_log ||
                        'Chưa có nhật ký.'}
                    </pre>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


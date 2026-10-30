'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle2,
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
import type { BackupItem, BackupJob, ServerRecord } from '@/types';

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

  const [selectedJob, setSelectedJob] = useState<ExtendedJob | null>(null);
  const [jobItems, setJobItems] = useState<BackupItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Activity className="w-5 h-5 text-blue-400" />
            Tiến trình & Lịch sử Sao lưu / Khôi phục
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Theo dõi thời gian thực %, tốc độ truyền tải, trạng thái Auto-Resume, khóa Pin bảo vệ bản sạch và kết quả kiểm định SQL Sandbox.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <select
            value={filterServer}
            onChange={(e) => setFilterServer(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200"
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
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-200"
          >
            <option value="">Tất cả loại Job</option>
            <option value="BACKUP">Sao lưu (BACKUP)</option>
            <option value="RESTORE">Khôi phục (RESTORE)</option>
          </select>

          <button
            onClick={() => void loadJobs()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Làm mới
          </button>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
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
                            className={`text-[10px] px-1.5 py-0.2 rounded border ${getPanelBadgeClass(
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
                            onClick={() => void openJobDetail(job)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            Chi tiết
                          </button>

                          {job.job_type === 'BACKUP' &&
                            status === 'COMPLETED' && (
                              <Link
                                href={`/explorer?jobId=${job.id}`}
                                title="Mở File Explorer & Diff Viewer"
                                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-400 border border-slate-700"
                              >
                                <FolderGit2 className="w-3.5 h-3.5" />
                              </Link>
                            )}

                          {['RUNNING', 'QUEUED', 'RESUMING'].includes(status) && (
                            <button
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
                              onClick={() => void runJobAction(job.id, 'retry')}
                              title="Thử lại / Nối tiếp Auto-Resume"
                              className="p-1.5 rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500 hover:text-slate-950"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}

                          <button
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

                          <button
                            onClick={() => void deleteJob(job)}
                            className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400"
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

      {/* Job Details Modal */}
      {selectedJob && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-4xl w-full p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  Chi tiết Job #{selectedJob.id} — {selectedJob.server_hostname}{' '}
                  ({selectedJob.snapshot_name})
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Phân vùng: {selectedJob.volume_name} (
                  {selectedJob.volume_mount_path}) • Tổng file:{' '}
                  {selectedJob.files_total} (Đổi: {selectedJob.files_changed})
                </p>
              </div>
              <button
                onClick={() => setSelectedJob(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {selectedJob.anomaly_detected === 1 && (
              <div className="p-3.5 rounded-xl bg-rose-500/15 border border-rose-500/40 text-xs text-rose-200">
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
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-200">
                        Danh sách Website & Database trong Snapshot (
                        {jobItems.length} domains)
                      </h4>
                      <button
                        onClick={() =>
                          void runJobAction(selectedJob.id, 'verify_sandbox')
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs bg-violet-600/20 hover:bg-violet-600 text-violet-300 hover:text-white border border-violet-500/30"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        Chạy lại Kiểm định SQL Sandbox
                      </button>
                    </div>

                    <div className="border border-slate-800 rounded-xl overflow-hidden">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-950 text-slate-400">
                          <tr>
                            <th className="p-3">Domain / System User</th>
                            <th className="p-3">Mã nguồn</th>
                            <th className="p-3">Databases (.sql.zst/.gz)</th>
                            <th className="p-3">Trạng thái Sandbox</th>
                            <th className="p-3 text-right">Khôi phục</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {jobItems.map((it) => (
                            <tr key={it.id}>
                              <td className="p-3">
                                <div className="font-semibold text-white">
                                  {it.domain_name}
                                </div>
                                <div className="text-[11px] font-mono text-slate-400">
                                  User: {it.system_user} • {it.php_version}
                                </div>
                              </td>
                              <td className="p-3 text-slate-300">
                                {formatBytes(it.webroot_size_bytes)}
                              </td>
                              <td className="p-3 font-mono text-[11px] text-cyan-300">
                                {it.databases_list.length === 0
                                  ? 'Không dùng DB'
                                  : it.databases_list
                                      .map(
                                        (d) =>
                                          `${d.name} (${formatBytes(
                                            d.size_bytes
                                          )})`
                                      )
                                      .join(', ')}
                              </td>
                              <td className="p-3">
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
                              <td className="p-3 text-right">
                                <Link
                                  href={`/restore?itemId=${it.id}`}
                                  className="px-2.5 py-1 rounded bg-blue-600/20 hover:bg-blue-600 text-blue-300 hover:text-white border border-blue-500/30"
                                >
                                  Restore
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-slate-200">
                    Nhật ký Thực thi Chi tiết (Worker Execution Log)
                  </h4>
                  <pre className="bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs text-slate-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
                    {selectedJob.live_log ||
                      selectedJob.error_log ||
                      'Chưa có nhật ký.'}
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


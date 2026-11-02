'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  CalendarClock,
  Layers,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import type { BackupSchedule, ServerRecord } from '@/types';

export default function SchedulesPage() {
  const [schedules, setSchedules] = useState<BackupSchedule[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [showModal, setShowModal] = useState(false);

  const [form, setForm] = useState({
    name: 'Sao lưu tự động hàng đêm (01:00 AM)',
    cron_expression: '0 1 * * *',
    server_ids: [] as number[],
    max_concurrency: 2,
    daily: 7,
    weekly: 4,
    monthly: 6,
    verify_db_sandbox: true,
    btrfs_snapshot_after: true,
  });

  // GFS Retention Simulator / Executor
  const [gfsServerId, setGfsServerId] = useState<string>('');
  const [gfsResult, setGfsResult] = useState<{
    keptSnapshots: Array<{ snapshotName: string; reason: string }>;
    deletedSnapshots: string[];
    dryRun: boolean;
  } | null>(null);

  const loadData = useCallback(async () => {
    const [scRes, srRes] = await Promise.all([
      fetch('/api/schedules'),
      fetch('/api/servers'),
    ]);
    if (scRes.ok) setSchedules((await scRes.json()).schedules || []);
    if (srRes.ok) {
      const list = (await srRes.json()).servers || [];
      setServers(list);
      if (list.length > 0 && !gfsServerId) {
        setGfsServerId(String(list[0].id));
      }
    }
  }, [gfsServerId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const toggleServerInForm = (id: number) => {
    setForm((prev) => ({
      ...prev,
      server_ids: prev.server_ids.includes(id)
        ? prev.server_ids.filter((x) => x !== id)
        : [...prev.server_ids, id],
    }));
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const resp = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        cron_expression: form.cron_expression,
        server_ids: form.server_ids,
        max_concurrency: form.max_concurrency,
        retention_policy: {
          daily: form.daily,
          weekly: form.weekly,
          monthly: form.monthly,
        },
        verify_db_sandbox: form.verify_db_sandbox,
        btrfs_snapshot_after: form.btrfs_snapshot_after,
        enabled: true,
      }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      alert(json.error || 'Không thể lưu lịch chạy');
      return;
    }
    setShowModal(false);
    await loadData();
  };

  const toggleEnabled = async (sc: BackupSchedule) => {
    await fetch(`/api/schedules/${sc.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !sc.enabled }),
    });
    await loadData();
  };

  const runScheduleNow = async (sc: BackupSchedule) => {
    const resp = await fetch(`/api/schedules/${sc.id}`, { method: 'POST' });
    const json = await resp.json();
    if (resp.ok) {
      alert(
        `Đã đẩy ${
          json.jobIds?.length || 0
        } máy chủ vào hàng đợi sao lưu thành công!`
      );
    } else {
      alert(json.error || 'Lỗi kích hoạt lịch chạy');
    }
  };

  const deleteSchedule = async (sc: BackupSchedule) => {
    if (!confirm(`Xóa lịch chạy "${sc.name}"?`)) return;
    await fetch(`/api/schedules/${sc.id}`, { method: 'DELETE' });
    await loadData();
  };

  const runGfsRetention = async (dryRun: boolean) => {
    if (!gfsServerId) return;
    const resp = await fetch('/api/schedules/retention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: Number(gfsServerId),
        dryRun,
        policy: { daily: 7, weekly: 4, monthly: 6 },
      }),
    });
    const json = await resp.json();
    if (resp.ok) {
      setGfsResult({
        keptSnapshots: json.keptSnapshots || [],
        deletedSnapshots: json.deletedSnapshots || [],
        dryRun,
      });
    } else {
      alert(json.error || 'Lỗi chạy GFS Retention');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <CalendarClock className="w-5 h-5 text-blue-400 shrink-0" />
            <span>
              Lập lịch Cron & Chính sách Lưu trữ GFS (Grandfather-Father-Son)
            </span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Điều phối Concurrency chống nghẽn băng thông và tự động giữ lại 7 Daily + 4 Weekly (Chủ nhật) + 6 Monthly (Mùng 1).
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setForm((f) => ({
              ...f,
              server_ids: servers.map((s) => s.id),
            }));
            setShowModal(true);
          }}
          className="w-full sm:w-auto justify-center min-h-[40px] shrink-0 whitespace-nowrap inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
        >
          <Plus className="w-4 h-4 shrink-0" />
          Tạo Lịch Sao lưu Mới
        </button>
      </div>

      {/* Schedules List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {schedules.map((sc) => (
          <div
            key={sc.id}
            className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white break-words">
                  {sc.name}
                </h3>
                <div className="text-xs font-mono text-cyan-400 mt-1 break-words">
                  Cron: {sc.cron_expression} • Song song tối đa:{' '}
                  {sc.max_concurrency} VPS
                </div>
              </div>
              <button
                type="button"
                onClick={() => void toggleEnabled(sc)}
                className={`shrink-0 whitespace-nowrap min-h-[32px] px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors ${
                  sc.enabled
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    : 'bg-slate-800 text-slate-400 border-slate-700'
                }`}
              >
                {sc.enabled ? 'ĐANG BẬT' : 'TẠM DỪNG'}
              </button>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="px-2.5 py-1 rounded-md bg-slate-950 border border-slate-800 text-slate-300">
                GFS: {sc.retention_policy.daily} Daily •{' '}
                {sc.retention_policy.weekly} Weekly •{' '}
                {sc.retention_policy.monthly} Monthly
              </span>
              {sc.verify_db_sandbox && (
                <span className="px-2.5 py-1 rounded-md bg-violet-500/15 border border-violet-500/30 text-violet-300">
                  MariaDB Sandbox Verify ✅
                </span>
              )}
              {sc.btrfs_snapshot_after && (
                <span className="px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
                  Btrfs Immutable WORM 🔒
                </span>
              )}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-800 text-xs">
              <span className="text-slate-400">
                Áp dụng {sc.server_ids.length} VPS • Chạy cuối:{' '}
                {formatDateTime(sc.last_run_at)}
              </span>

              <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
                <button
                  type="button"
                  onClick={() => void runScheduleNow(sc)}
                  className="flex-1 sm:flex-initial justify-center min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current shrink-0" />
                  Kích hoạt Chạy Ngay
                </button>
                <button
                  type="button"
                  onClick={() => void deleteSchedule(sc)}
                  aria-label={`Xóa lịch chạy ${sc.name}`}
                  className="h-9 w-9 min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 shrink-0 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* GFS Retention Inspector */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>Bộ Kiểm tra & Dọn dẹp Vòng đời GFS (Dry-Run & Thực thi)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Tự động bảo vệ bản Latest và các bản Pinned chống Ransomware trước khi giải phóng ổ cứng NAS.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full lg:w-auto text-xs">
            <select
              value={gfsServerId}
              onChange={(e) => setGfsServerId(e.target.value)}
              className="flex-1 sm:flex-initial w-full sm:w-auto min-w-0 min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white truncate"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.hostname}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void runGfsRetention(true)}
              className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              Xem trước (Dry-Run)
            </button>
            <button
              type="button"
              onClick={() => void runGfsRetention(false)}
              className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center px-3.5 py-2 rounded-lg bg-rose-600/20 hover:bg-rose-600 text-rose-300 hover:text-white border border-rose-500/30 font-medium transition-colors"
            >
              Dọn dẹp GFS Ngay
            </button>
          </div>
        </div>

        {gfsResult && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-2">
            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
              <div className="font-semibold text-emerald-400 mb-2">
                Các bản Snapshot được GIỮ LẠI ({gfsResult.keptSnapshots.length})
              </div>
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {gfsResult.keptSnapshots.map((k) => (
                  <div
                    key={k.snapshotName}
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 font-mono text-slate-300"
                  >
                    <span className="break-all">{k.snapshotName}</span>
                    <span className="text-emerald-400 font-sans shrink-0">
                      {k.reason}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-950 border border-slate-800">
              <div className="font-semibold text-rose-400 mb-2">
                {gfsResult.dryRun
                  ? 'Các bản hết hạn sẽ được XÓA'
                  : 'Các bản đã XÓA giải phóng dung lượng'}{' '}
                ({gfsResult.deletedSnapshots.length})
              </div>
              {gfsResult.deletedSnapshots.length === 0 ? (
                <div className="text-slate-500">
                  Chưa có bản sao lưu nào vượt ngưỡng GFS (7 Daily / 4 Weekly / 6 Monthly).
                </div>
              ) : (
                <div className="space-y-1 font-mono text-rose-300">
                  {gfsResult.deletedSnapshots.map((d) => (
                    <div key={d} className="break-all">
                      {d}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create Schedule Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full p-4 sm:p-6 space-y-4 max-h-[calc(100dvh-2rem)] overflow-y-auto text-xs">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-bold text-white">
                Thiết lập Lịch Sao lưu Tự động & GFS
              </h3>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                aria-label="Đóng"
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateSchedule} className="space-y-4">
              <div>
                <label className="block text-slate-300 mb-1 font-medium">
                  Tên lịch chạy
                </label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Biểu thức Cron
                  </label>
                  <input
                    required
                    value={form.cron_expression}
                    onChange={(e) =>
                      setForm({ ...form, cron_expression: e.target.value })
                    }
                    placeholder="0 1 * * *"
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Số VPS chạy song song
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form.max_concurrency}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_concurrency: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1.5 font-medium">
                  Chính sách GFS (Daily / Weekly / Monthly)
                </label>
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="min-w-0 flex flex-col justify-between">
                    <span className="block text-[11px] text-slate-400 mb-1">
                      Giữ theo Ngày (Daily)
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={form.daily}
                      onChange={(e) =>
                        setForm({ ...form, daily: Number(e.target.value) })
                      }
                      className="w-full min-w-0 min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono"
                      placeholder="7"
                    />
                  </div>
                  <div className="min-w-0 flex flex-col justify-between">
                    <span className="block text-[11px] text-slate-400 mb-1">
                      Giữ theo Tuần (Weekly)
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={form.weekly}
                      onChange={(e) =>
                        setForm({ ...form, weekly: Number(e.target.value) })
                      }
                      className="w-full min-w-0 min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono"
                      placeholder="4"
                    />
                  </div>
                  <div className="min-w-0 flex flex-col justify-between">
                    <span className="block text-[11px] text-slate-400 mb-1">
                      Giữ theo Tháng (Monthly)
                    </span>
                    <input
                      type="number"
                      min={0}
                      value={form.monthly}
                      onChange={(e) =>
                        setForm({ ...form, monthly: Number(e.target.value) })
                      }
                      className="w-full min-w-0 min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-2 text-white font-mono"
                      placeholder="6"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1.5 font-medium">
                  Chọn Máy chủ VPS áp dụng
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto p-3 rounded-xl bg-slate-950 border border-slate-800">
                  {servers.map((s) => (
                    <label
                      key={s.id}
                      className="flex items-start gap-2.5 text-slate-200 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={form.server_ids.includes(s.id)}
                        onChange={() => toggleServerInForm(s.id)}
                        className="mt-0.5 shrink-0"
                      />
                      <span className="break-all">
                        {s.hostname} ({s.panel_type})
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <label className="flex items-start gap-2.5 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.verify_db_sandbox}
                  onChange={(e) =>
                    setForm({ ...form, verify_db_sandbox: e.target.checked })
                  }
                  className="mt-0.5 shrink-0"
                />
                <span>
                  Tự động nạp kiểm định SQL trên MariaDB Sandbox sau khi sao lưu
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.btrfs_snapshot_after}
                  onChange={(e) =>
                    setForm({ ...form, btrfs_snapshot_after: e.target.checked })
                  }
                  className="mt-0.5 shrink-0"
                />
                <span>
                  Tự động chụp Btrfs Immutable Snapshot (WORM 7 ngày) sau ca sao lưu
                </span>
              </label>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                >
                  Lưu Lịch Chạy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


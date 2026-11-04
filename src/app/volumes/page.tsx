'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { StorageVolume } from '@/types';

export default function VolumesPage() {
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [wormLoading, setWormLoading] = useState(false);
  const [wormBanner, setWormBanner] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const [form, setForm] = useState({
    name: 'NAS Volume 3',
    mount_path: '/mnt/vol3',
    max_usage_percent: 85,
    min_free_gb: 10,
    priority: 3,
    btrfs_immutable_enabled: true,
    btrfs_retention_days: 7,
  });

  const loadVolumes = useCallback(async (refresh = true) => {
    setLoading(true);
    try {
      const resp = await fetch(`/api/volumes?refresh=${refresh ? '1' : '0'}`);
      if (resp.ok) {
        setVolumes((await resp.json()).volumes || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadVolumes(true);
  }, [loadVolumes]);

  const handleAddVolume = async (e: React.FormEvent) => {
    e.preventDefault();
    const resp = await fetch('/api/volumes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const json = await resp.json();
    if (!resp.ok) {
      alert(json.error || 'Không thể thêm Volume');
      return;
    }
    setVolumes(json.volumes || []);
    setShowAdd(false);
  };

  const toggleMaintenance = async (vol: StorageVolume) => {
    const nextStatus = vol.status === 'MAINTENANCE' ? 'ACTIVE' : 'MAINTENANCE';
    const resp = await fetch(`/api/volumes/${vol.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    if (resp.ok) {
      setVolumes((await resp.json()).volumes || []);
    }
  };

  const updateThresholds = async (
    vol: StorageVolume,
    maxPct: number,
    minGb: number,
    priority: number
  ) => {
    const resp = await fetch(`/api/volumes/${vol.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        max_usage_percent: maxPct,
        min_free_gb: minGb,
        priority,
      }),
    });
    if (resp.ok) {
      setVolumes((await resp.json()).volumes || []);
    }
  };

  const deleteVolume = async (vol: StorageVolume) => {
    if (!confirm(`Xóa cấu hình phân vùng ${vol.name}? (Không xóa dữ liệu vật lý)`))
      return;
    await fetch(`/api/volumes/${vol.id}`, { method: 'DELETE' });
    await loadVolumes(false);
  };

  const triggerWormSnapshot = async () => {
    setWormLoading(true);
    setWormBanner(null);
    try {
      const resp = await fetch('/api/volumes/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await resp.json().catch(() => ({}));
      const isOk = resp.ok && data.ok !== false;
      setWormBanner({
        ok: isOk,
        message:
          data.message ||
          data.error ||
          (isOk
            ? 'Đã gửi yêu cầu chụp OS-Level Immutable WORM Snapshot.'
            : 'Không thể tạo OS-Level WORM Snapshot.'),
      });
    } catch {
      setWormBanner({
        ok: false,
        message:
          'Mất kết nối trình duyệt tới máy chủ khi chờ tạo WORM Snapshot.',
      });
    } finally {
      setWormLoading(false);
    }
  };

  const openAddModal = () => {
    const nextIdx = volumes.length + 1;
    setForm({
      name: `NAS Volume ${nextIdx}`,
      mount_path: `/mnt/vol${nextIdx}`,
      max_usage_percent: 85,
      min_free_gb: 10,
      priority: nextIdx,
      btrfs_immutable_enabled: true,
      btrfs_retention_days: 7,
    });
    setShowAdd(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-blue-400 shrink-0" />
            <span>Quản lý Đa Phân vùng Thông minh &amp; Khóa Bất biến (WORM)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Tự động kiểm định Filesystem / POSIX Hard-Link, giám sát df / statfs và chuyển Volume khi đầy ≥ 85% kèm Local Seeding bảo toàn chuỗi tăng dần.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadVolumes(true)}
            className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            Kiểm tra Dung lượng
          </button>
          <button
            type="button"
            onClick={() => void triggerWormSnapshot()}
            disabled={wormLoading}
            className="w-full sm:w-auto justify-center min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 transition-colors disabled:opacity-50"
          >
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span>
              {wormLoading
                ? 'Đang tạo WORM Snapshot...'
                : 'Chụp WORM Snapshot Ngay'}
            </span>
          </button>
          <button
            type="button"
            onClick={openAddModal}
            className="flex-1 sm:flex-initial justify-center min-h-[40px] whitespace-nowrap inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Plus className="w-4 h-4 shrink-0" />
            Thêm Volume
          </button>
        </div>
      </div>

      {wormBanner && (
        <div
          className={`p-4 rounded-xl text-xs flex items-start gap-2.5 border ${
            wormBanner.ok
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
          }`}
        >
          {wormBanner.ok ? (
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          )}
          <span className="break-words leading-relaxed">{wormBanner.message}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {loading && volumes.length === 0 ? (
          <div className="text-xs text-slate-400">Đang kiểm tra ổ cứng NAS...</div>
        ) : (
          volumes.map((vol) => {
            const pct =
              vol.total_bytes > 0
                ? Math.min(100, (vol.used_bytes / vol.total_bytes) * 100)
                : 0;
            const freeGb = vol.free_bytes / 1024 ** 3;
            const reservedBytes = Math.max(
              0,
              vol.total_bytes - vol.used_bytes - vol.free_bytes
            );
            const hasQuotaOrReserve =
              vol.total_bytes > 0 && reservedBytes > vol.total_bytes * 0.05;
            const isFullByPct =
              vol.max_usage_percent > 0 && pct >= vol.max_usage_percent;
            const isFullByFreeGb =
              vol.min_free_gb > 0 && freeGb < vol.min_free_gb;

            return (
              <div
                key={vol.id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-base font-bold text-white flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>{vol.name}</span>
                      <span className="text-xs font-normal text-slate-400">
                        • Ưu tiên #{vol.priority}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-cyan-400 mt-0.5 break-all">
                      Mount Path: {vol.mount_path}
                    </div>
                    {vol.capabilities && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-200 border border-slate-700 text-[11px] font-mono">
                          FS: {vol.capabilities.fs_type.toUpperCase()}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border ${
                            vol.capabilities.hardlink_supported
                              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                              : 'bg-rose-500/15 text-rose-300 border-rose-500/35'
                          }`}
                        >
                          {vol.capabilities.hardlink_supported ? (
                            <CheckCircle2 className="w-3 h-3 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                          )}
                          {vol.capabilities.hardlink_supported
                            ? 'Hard-Link OK'
                            : 'Không hỗ trợ Hard-Link'}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[11px] border ${
                            vol.capabilities.writable
                              ? 'bg-blue-500/10 text-blue-300 border-blue-500/25'
                              : 'bg-amber-500/15 text-amber-300 border-amber-500/35'
                          }`}
                        >
                          {vol.capabilities.writable ? 'Ghi/Đọc OK' : 'Chỉ đọc'}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={`px-2.5 py-1 rounded text-xs font-semibold border ${
                        vol.status === 'ACTIVE'
                          ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                          : vol.status === 'FULL'
                          ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                          : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}
                    >
                      {vol.status}
                    </span>
                    <button
                      type="button"
                      onClick={() => void deleteVolume(vol)}
                      aria-label={`Xóa phân vùng ${vol.name}`}
                      className="h-9 w-9 min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="text-slate-200 font-medium">
                      Đã sử dụng: {formatBytes(vol.used_bytes)} ({pct.toFixed(1)}%)
                    </span>
                    <span className="text-slate-400">
                      Còn trống: {formatBytes(vol.free_bytes)} / Tổng{' '}
                      {formatBytes(vol.total_bytes)}
                    </span>
                  </div>
                  <div className="w-full h-3 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                    <div
                      className={`h-full transition-all duration-500 ${
                        vol.status === 'FULL'
                          ? 'bg-rose-500'
                          : pct >= 75
                          ? 'bg-amber-500'
                          : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                      }`}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                  {hasQuotaOrReserve && (
                    <div className="text-[11px] text-slate-500 break-words">
                      Lưu ý: Khoảng {formatBytes(reservedBytes)} trên ổ cứng đang được giữ bởi Hạn ngạch (Quota / ZFS Reservation), LUN hoặc phân vùng hệ thống NAS nên không tính vào dung lượng trống khả dụng.
                    </div>
                  )}
                  {vol.capabilities?.warning && (
                    <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 flex items-start gap-2 break-words">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                      <span>{vol.capabilities.warning}</span>
                    </div>
                  )}
                  {vol.status === 'FULL' && (
                    <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-200 break-words">
                      {isFullByPct
                        ? `Phân vùng đang báo FULL do tỷ lệ sử dụng (${pct.toFixed(1)}%) đã chạm ngưỡng đầy (${vol.max_usage_percent}%).`
                        : isFullByFreeGb
                        ? `Phân vùng đang báo FULL do dung lượng trống khả dụng (${formatBytes(vol.free_bytes)}) nhỏ hơn ô "Trống tối thiểu" (${vol.min_free_gb} GB). Hãy hạ "Trống tối thiểu (GB)" xuống 10 (hoặc 0 để chỉ tính theo %).`
                        : `Phân vùng đang ở trạng thái FULL.`}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-800 text-xs">
                  <div className="flex flex-col justify-between">
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Ngưỡng đầy (%)
                    </label>
                    <input
                      key={`max-${vol.id}-${vol.max_usage_percent}`}
                      type="number"
                      min={1}
                      max={99}
                      defaultValue={vol.max_usage_percent}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          Number(e.target.value),
                          vol.min_free_gb,
                          vol.priority
                        )
                      }
                      className="w-full min-h-[40px] bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                  <div className="flex flex-col justify-between">
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Trống tối thiểu (GB)
                    </label>
                    <input
                      key={`min-${vol.id}-${vol.min_free_gb}`}
                      type="number"
                      min={0}
                      defaultValue={vol.min_free_gb}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          vol.max_usage_percent,
                          Number(e.target.value),
                          vol.priority
                        )
                      }
                      className="w-full min-h-[40px] bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                  <div className="flex flex-col justify-between">
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Độ ưu tiên
                    </label>
                    <input
                      key={`prio-${vol.id}-${vol.priority}`}
                      type="number"
                      min={1}
                      defaultValue={vol.priority}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          vol.max_usage_percent,
                          vol.min_free_gb,
                          Number(e.target.value)
                        )
                      }
                      className="w-full min-h-[40px] bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[11px] text-slate-500 pt-1">
                  <span>Kiểm tra gần nhất: {formatDateTime(vol.last_checked_at)}</span>
                  <button
                    type="button"
                    onClick={() => void toggleMaintenance(vol)}
                    className="text-left sm:text-right text-amber-400 hover:underline font-medium"
                  >
                    {vol.status === 'MAINTENANCE'
                      ? 'Mở lại trạng thái ACTIVE'
                      : 'Chuyển sang Bảo trì (MAINTENANCE)'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Volume Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-4 sm:p-6 space-y-4 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-bold text-white">
                Thêm Phân vùng Lưu trữ NAS Mới
              </h3>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                aria-label="Đóng"
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddVolume} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-300 mb-1">Tên hiển thị</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                />
              </div>
              <div>
                <label className="block text-slate-300 mb-1">
                  Đường dẫn Mount trong Container
                </label>
                <input
                  required
                  value={form.mount_path}
                  onChange={(e) =>
                    setForm({ ...form, mount_path: e.target.value })
                  }
                  placeholder="/mnt/vol3"
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1">Max %</label>
                  <input
                    type="number"
                    value={form.max_usage_percent}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_usage_percent: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1">Min GB</label>
                  <input
                    type="number"
                    value={form.min_free_gb}
                    onChange={(e) =>
                      setForm({ ...form, min_free_gb: Number(e.target.value) })
                    }
                    className="w-full min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1">Priority</label>
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) =>
                      setForm({ ...form, priority: Number(e.target.value) })
                    }
                    className="w-full min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                >
                  Thêm Phân vùng
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


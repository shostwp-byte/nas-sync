'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
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
  const [wormMsg, setWormMsg] = useState('');

  const [form, setForm] = useState({
    name: 'Synology Volume 3',
    mount_path: '/mnt/vol3',
    max_usage_percent: 85,
    min_free_gb: 200,
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
    setWormMsg('');
    try {
      const resp = await fetch('/api/volumes/btrfs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: 7 }),
      });
      const data = await resp.json();
      setWormMsg(data.message || 'Đã gửi yêu cầu Btrfs Immutable Snapshot.');
    } finally {
      setWormLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-blue-400" />
            Quản lý Đa Phân vùng Thông minh & Btrfs WORM
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Tự động kiểm tra df / statfs trước mỗi phiên chạy, chuyển Volume khi đầy ≥ 85% kèm Local Seeding bảo toàn chuỗi Incremental Hard-Link.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => void triggerWormSnapshot()}
            disabled={wormLoading}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            {wormLoading
              ? 'Đang tạo WORM Snapshot...'
              : 'Chụp Btrfs Immutable (WORM 7 ngày)'}
          </button>
          <button
            onClick={() => void loadVolumes(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Quét df -B1
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white"
          >
            <Plus className="w-4 h-4" />
            Thêm Volume
          </button>
        </div>
      </div>

      {wormMsg && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{wormMsg}</span>
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

            return (
              <div
                key={vol.id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-base font-bold text-white flex items-center gap-2">
                      {vol.name}
                      <span className="text-xs font-normal text-slate-400">
                        • Ưu tiên #{vol.priority}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-cyan-400 mt-0.5">
                      Mount Path: {vol.mount_path}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
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
                      onClick={() => void deleteVolume(vol)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
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
                        pct >= vol.max_usage_percent
                          ? 'bg-rose-500'
                          : 'bg-gradient-to-r from-blue-500 to-cyan-400'
                      }`}
                      style={{ width: `${Math.max(2, pct)}%` }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-800 text-xs">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Ngưỡng đầy (%)
                    </label>
                    <input
                      type="number"
                      defaultValue={vol.max_usage_percent}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          Number(e.target.value),
                          vol.min_free_gb,
                          vol.priority
                        )
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Trống tối thiểu (GB)
                    </label>
                    <input
                      type="number"
                      defaultValue={vol.min_free_gb}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          vol.max_usage_percent,
                          Number(e.target.value),
                          vol.priority
                        )
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">
                      Độ ưu tiên
                    </label>
                    <input
                      type="number"
                      defaultValue={vol.priority}
                      onBlur={(e) =>
                        void updateThresholds(
                          vol,
                          vol.max_usage_percent,
                          vol.min_free_gb,
                          Number(e.target.value)
                        )
                      }
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-white font-mono"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                  <span>Kiểm tra gần nhất: {formatDateTime(vol.last_checked_at)}</span>
                  <button
                    onClick={() => void toggleMaintenance(vol)}
                    className="text-amber-400 hover:underline"
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
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                Thêm Phân vùng Synology NAS Mới
              </h3>
              <button
                onClick={() => setShowAdd(false)}
                className="text-slate-400 hover:text-white"
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
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
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
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
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
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Min GB</label>
                  <input
                    type="number"
                    value={form.min_free_gb}
                    onChange={(e) =>
                      setForm({ ...form, min_free_gb: Number(e.target.value) })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 mb-1">Priority</label>
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) =>
                      setForm({ ...form, priority: Number(e.target.value) })
                    }
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold"
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


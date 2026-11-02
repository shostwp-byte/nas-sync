'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  Copy,
  Edit3,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  SearchCode,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useRealtime } from '@/components/SocketProvider';
import { formatDateTime, getPanelBadgeClass } from '@/lib/format';
import type {
  DiscoveredDomain,
  PanelType,
  ServerRecord,
  SSHKeyRecord,
  StorageVolume,
  UserRole,
} from '@/types';

interface ExtendedServer extends ServerRecord {
  snapshots_count?: number;
  last_backup_at?: string | null;
}

export default function ServersPage() {
  const router = useRouter();
  const { lastUpdateCounter } = useRealtime();
  const [servers, setServers] = useState<ExtendedServer[]>([]);
  const [volumes, setVolumes] = useState<StorageVolume[]>([]);
  const [sshKeys, setSshKeys] = useState<SSHKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [userRole, setUserRole] = useState<UserRole>('ADMIN');

  // Server Modal
  const [showServerModal, setShowServerModal] = useState(false);
  const [editingServer, setEditingServer] = useState<ExtendedServer | null>(null);
  const [form, setForm] = useState({
    hostname: '',
    ip_address: '',
    ssh_port: 22,
    ssh_user: 'root',
    ssh_key_path: '',
    panel_type: 'DIRECTADMIN' as PanelType,
    assigned_volume_id: '' as string | number,
    bw_limit_kbps: 25600,
    is_mock: false,
    notes: '',
    custom_excludes: '',
  });

  // SSH Keys Modal
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [keyName, setKeyName] = useState('nas_sync_ed25519');
  const [keyType, setKeyType] = useState<'ed25519' | 'rsa'>('ed25519');
  const [generatingKey, setGeneratingKey] = useState(false);
  const [copiedId, setCopiedId] = useState<number | null>(null);

  // Discovery Test Modal
  const [testingServer, setTestingServer] = useState<ExtendedServer | null>(null);
  const [testLoading, setTestLoading] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string;
    ssh?: { osInfo?: string; uptime?: string; latencyMs: number };
    domains?: DiscoveredDomain[];
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [sRes, vRes, kRes] = await Promise.all([
        fetch('/api/servers'),
        fetch('/api/volumes?refresh=0'),
        fetch('/api/ssh-keys'),
      ]);
      if (sRes.ok) setServers((await sRes.json()).servers || []);
      if (vRes.ok) setVolumes((await vRes.json()).volumes || []);
      if (kRes.ok) setSshKeys((await kRes.json()).keys || []);
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    void loadData();
  }, [loadData, lastUpdateCounter]);

  const openAddServer = () => {
    setEditingServer(null);
    setForm({
      hostname: '',
      ip_address: '',
      ssh_port: 22,
      ssh_user: 'root',
      ssh_key_path: sshKeys[0]?.private_key_path || '',
      panel_type: 'DIRECTADMIN',
      assigned_volume_id: volumes[0]?.id || '',
      bw_limit_kbps: 25600,
      is_mock: false,
      notes: '',
      custom_excludes: '',
    });
    setShowServerModal(true);
  };

  const openEditServer = (srv: ExtendedServer) => {
    setEditingServer(srv);
    setForm({
      hostname: srv.hostname,
      ip_address: srv.ip_address,
      ssh_port: srv.ssh_port,
      ssh_user: srv.ssh_user,
      ssh_key_path: srv.ssh_key_path || '',
      panel_type: srv.panel_type,
      assigned_volume_id: srv.assigned_volume_id || '',
      bw_limit_kbps: srv.bw_limit_kbps,
      is_mock: srv.is_mock === 1,
      notes: srv.notes || '',
      custom_excludes: srv.custom_excludes || '',
    });
    setShowServerModal(true);
  };

  const saveServer = async (e: React.FormEvent) => {
    e.preventDefault();
    const url = editingServer
      ? `/api/servers/${editingServer.id}`
      : '/api/servers';
    const method = editingServer ? 'PATCH' : 'POST';

    const resp = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        assigned_volume_id: form.assigned_volume_id
          ? Number(form.assigned_volume_id)
          : null,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      alert(data.error || 'Lỗi lưu máy chủ');
      return;
    }
    setShowServerModal(false);
    await loadData();
  };

  const deleteServer = async (srv: ExtendedServer) => {
    if (
      !confirm(
        `Bạn có chắc muốn xóa máy chủ ${srv.hostname} khỏi danh sách quản trị?`
      )
    )
      return;
    await fetch(`/api/servers/${srv.id}`, { method: 'DELETE' });
    await loadData();
  };

  const handleTestDiscovery = async (srv: ExtendedServer) => {
    setTestingServer(srv);
    setTestLoading(true);
    setTestResult(null);
    try {
      const resp = await fetch(`/api/servers/${srv.id}/test`, {
        method: 'POST',
      });
      const json = await resp.json();
      setTestResult(json);
    } finally {
      setTestLoading(false);
      await loadData();
    }
  };

  const handleStartBackup = async (srv: ExtendedServer) => {
    const resp = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: srv.id, verifyDb: true }),
    });
    if (resp.ok) {
      router.push('/jobs');
    } else {
      const err = await resp.json();
      alert(err.error || 'Không thể tạo tiến trình sao lưu.');
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingKey(true);
    try {
      const resp = await fetch('/api/ssh-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', name: keyName, keyType }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        alert(json.error || 'Không thể sinh khóa SSH.');
        return;
      }
      setSshKeys(json.keys || []);
      setKeyName(`nas_sync_${Date.now().toString().slice(-4)}`);
    } finally {
      setGeneratingKey(false);
    }
  };

  const copyCommand = async (key: SSHKeyRecord) => {
    const safePub = key.public_key.trim().replace(/'/g, "'\\''");
    const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '${safePub}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (restorecon -Rv ~/.ssh 2>/dev/null || true)`;
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(cmd);
    } else {
      const ta = document.createElement('textarea');
      ta.value = cmd;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(key.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <Server className="w-5 h-5 text-blue-400 shrink-0" />
            <span>Quản lý Máy chủ VPS Đa Control Panel</span>
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Kết nối Agentless Pull qua SSH Root, tự động đọc cấu hình DirectAdmin, cPanel, Plesk, aaPanel với Zero-Impact (nice/ionice).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            className="flex-1 sm:flex-initial justify-center whitespace-nowrap min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5 shrink-0" />
            Làm mới
          </button>
          {userRole === 'ADMIN' && (
            <>
              <button
                type="button"
                onClick={() => setShowKeyModal(true)}
                className="flex-1 sm:flex-initial justify-center whitespace-nowrap min-h-[40px] inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
              >
                <KeyRound className="w-4 h-4 text-amber-400 shrink-0" />
                Quản lý SSH Keys ({sshKeys.length})
              </button>
              <button
                type="button"
                onClick={openAddServer}
                className="w-full sm:w-auto flex-1 sm:flex-initial justify-center whitespace-nowrap min-h-[40px] inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/20 transition-colors"
              >
                <Plus className="w-4 h-4 shrink-0" />
                Thêm Máy chủ VPS
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile & Tablet Server Cards (< lg) */}
      <div className="lg:hidden">
        {loading ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-500">
            Đang tải danh sách máy chủ...
          </div>
        ) : servers.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center text-xs text-slate-500">
            Chưa có máy chủ VPS nào. Hãy nhấn &quot;Thêm Máy chủ VPS&quot; để bắt đầu.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {servers.map((srv) => (
              <div
                key={srv.id}
                className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3.5 flex flex-col justify-between"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium mb-0.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            srv.status === 'ONLINE'
                              ? 'bg-emerald-400'
                              : srv.status === 'BACKUP_RUNNING'
                              ? 'bg-blue-400 animate-ping'
                              : 'bg-rose-400'
                          }`}
                        />
                        <span
                          className={
                            srv.status === 'ONLINE'
                              ? 'text-emerald-400'
                              : srv.status === 'BACKUP_RUNNING'
                              ? 'text-blue-400'
                              : 'text-rose-400'
                          }
                        >
                          {srv.status === 'ONLINE'
                            ? 'ONLINE'
                            : srv.status === 'BACKUP_RUNNING'
                            ? 'ĐANG SAO LƯU'
                            : srv.status}
                        </span>
                        {srv.is_mock === 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
                            Demo Mode
                          </span>
                        )}
                      </div>
                      <div className="font-bold text-sm text-white break-all">
                        {srv.hostname}
                      </div>
                    </div>

                    <span
                      className={`px-2.5 py-1 rounded-md border font-semibold text-[11px] shrink-0 ${getPanelBadgeClass(
                        srv.panel_type
                      )}`}
                    >
                      {srv.panel_type}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs bg-slate-950/70 border border-slate-800/80 rounded-xl p-3">
                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                        SSH Endpoint
                      </div>
                      <div className="text-slate-200 font-mono break-all mt-0.5">
                        {srv.ssh_user}@{srv.ip_address}:{srv.ssh_port}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                        Volume & Băng thông
                      </div>
                      <div className="text-slate-200 font-medium break-words mt-0.5">
                        {srv.assigned_volume_name || 'Auto Routing'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-400">
                        {srv.bw_limit_kbps > 0
                          ? `${(srv.bw_limit_kbps / 1024).toFixed(1)} MB/s (${srv.bw_limit_kbps} KB/s)`
                          : 'Không giới hạn'}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                        SSH Private Key
                      </div>
                      <div className="text-[11px] font-mono text-slate-300 break-all mt-0.5">
                        {srv.ssh_key_path || 'Mặc định (/root/.ssh)'}
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                        Snapshots / Lần cuối
                      </div>
                      <div className="text-slate-200 font-medium mt-0.5">
                        {srv.snapshots_count || 0} bản sao lưu
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(srv.last_backup_at)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-2 text-xs">
                  {userRole === 'VIEWER' ? (
                    <span className="text-[11px] text-slate-500 italic py-1">
                      Chế độ Xem giám sát NOC (Read-Only)
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleTestDiscovery(srv)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700 transition-colors"
                      >
                        <SearchCode className="w-3.5 h-3.5 shrink-0" />
                        Quét thử
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleStartBackup(srv)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 font-medium transition-colors"
                      >
                        <Play className="w-3.5 h-3.5 fill-current shrink-0" />
                        Sao lưu ngay
                      </button>
                    </>
                  )}
                  {userRole === 'ADMIN' && (
                    <>
                      <button
                        type="button"
                        onClick={() => openEditServer(srv)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
                      >
                        <Edit3 className="w-3.5 h-3.5 shrink-0" />
                        Sửa
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteServer(srv)}
                        aria-label={`Xóa máy chủ ${srv.hostname}`}
                        className="ml-auto min-h-[40px] min-w-[40px] px-2.5 py-2 inline-flex items-center justify-center rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400 border border-slate-700/80 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop Servers Table (>= lg) */}
      <div className="hidden lg:block bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-xs">
            <thead>
              <tr className="bg-slate-950/70 text-slate-400 border-b border-slate-800">
                <th className="p-4 font-medium">Máy chủ Hostname / IP</th>
                <th className="p-4 font-medium">Control Panel</th>
                <th className="p-4 font-medium">Phân vùng Đang lưu</th>
                <th className="p-4 font-medium">Giới hạn Băng thông</th>
                <th className="p-4 font-medium">Snapshots / Lần cuối</th>
                <th className="p-4 font-medium text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    Đang tải danh sách máy chủ...
                  </td>
                </tr>
              ) : servers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">
                    Chưa có máy chủ VPS nào. Hãy nhấn &quot;Thêm Máy chủ VPS&quot; để bắt đầu.
                  </td>
                </tr>
              ) : (
                servers.map((srv) => (
                  <tr key={srv.id} className="hover:bg-slate-800/30">
                    <td className="p-4">
                      <div className="font-semibold text-sm text-white flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            srv.status === 'ONLINE'
                              ? 'bg-emerald-400'
                              : srv.status === 'BACKUP_RUNNING'
                              ? 'bg-blue-400 animate-ping'
                              : 'bg-rose-400'
                          }`}
                        />
                        <span>{srv.hostname}</span>
                        {srv.is_mock === 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                            Demo Mode
                          </span>
                        )}
                      </div>
                      <div className="text-slate-400 font-mono mt-0.5">
                        {srv.ssh_user}@{srv.ip_address}:{srv.ssh_port}
                      </div>
                    </td>

                    <td className="p-4">
                      <span
                        className={`px-2.5 py-1 rounded-md border font-semibold text-[11px] ${getPanelBadgeClass(
                          srv.panel_type
                        )}`}
                      >
                        {srv.panel_type}
                      </span>
                    </td>

                    <td className="p-4">
                      <div className="text-slate-200 font-medium">
                        {srv.assigned_volume_name || 'Tự động chọn'}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {srv.assigned_volume_path || ''}
                      </div>
                    </td>

                    <td className="p-4 text-slate-300 font-mono">
                      {srv.bw_limit_kbps > 0
                        ? `${(srv.bw_limit_kbps / 1024).toFixed(1)} MB/s (${srv.bw_limit_kbps} KB/s)`
                        : 'Không giới hạn'}
                    </td>

                    <td className="p-4">
                      <div className="text-slate-200 font-medium">
                        {srv.snapshots_count || 0} bản sao lưu
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {formatDateTime(srv.last_backup_at)}
                      </div>
                    </td>

                    <td className="p-4">
                      <div className="flex items-center justify-end gap-2">
                        {userRole === 'VIEWER' ? (
                          <span className="text-[11px] text-slate-500 italic">
                            Chỉ xem (NOC)
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleTestDiscovery(srv)}
                              title="Kiểm tra kết nối SSH & Quét thử danh sách Domain/DB"
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-slate-700"
                            >
                              <SearchCode className="w-3.5 h-3.5" />
                              Quét thử
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleStartBackup(srv)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 font-medium transition-colors"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              Backup ngay
                            </button>
                          </>
                        )}
                        {userRole === 'ADMIN' && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditServer(srv)}
                              title="Chỉnh sửa cấu hình máy chủ"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void deleteServer(srv)}
                              title="Xóa máy chủ"
                              className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-600/30 text-rose-400"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Server Modal */}
      {showServerModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full p-4 sm:p-6 space-y-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-base font-bold text-white break-all">
                {editingServer
                  ? `Chỉnh sửa Máy chủ ${editingServer.hostname}`
                  : 'Thêm Máy chủ VPS Mới'}
              </h3>
              <button
                type="button"
                onClick={() => setShowServerModal(false)}
                aria-label="Đóng"
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={saveServer} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Hostname (Định danh thư mục NAS) *
                  </label>
                  <input
                    required
                    value={form.hostname}
                    onChange={(e) =>
                      setForm({ ...form, hostname: e.target.value })
                    }
                    placeholder="vps01.example.com"
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Loại Control Panel *
                  </label>
                  <select
                    value={form.panel_type}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        panel_type: e.target.value as PanelType,
                      })
                    }
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                  >
                    <option value="DIRECTADMIN">DirectAdmin</option>
                    <option value="CPANEL">cPanel / WHM</option>
                    <option value="PLESK">Plesk Obsidian</option>
                    <option value="AAPANEL">aaPanel / BT Panel</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-2 flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Địa chỉ IP / Tailscale IP *
                  </label>
                  <input
                    required
                    value={form.ip_address}
                    onChange={(e) =>
                      setForm({ ...form, ip_address: e.target.value })
                    }
                    placeholder="103.221.220.10"
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    SSH Port
                  </label>
                  <input
                    type="number"
                    value={form.ssh_port}
                    onChange={(e) =>
                      setForm({ ...form, ssh_port: Number(e.target.value) })
                    }
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Đường dẫn SSH Private Key trên NAS
                  </label>
                  <div>
                    <input
                      list="ssh-keys-list"
                      value={form.ssh_key_path}
                      onChange={(e) =>
                        setForm({ ...form, ssh_key_path: e.target.value })
                      }
                      placeholder="/root/.ssh/id_ed25519"
                      className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                    />
                    <datalist id="ssh-keys-list">
                      {sshKeys.map((k) => (
                        <option key={k.id} value={k.private_key_path}>
                          {k.name}
                        </option>
                      ))}
                    </datalist>
                  </div>
                </div>

                <div className="flex flex-col justify-between">
                  <label className="block text-slate-300 mb-1 font-medium">
                    Giới hạn Băng thông (--bwlimit KB/s)
                  </label>
                  <input
                    type="number"
                    value={form.bw_limit_kbps}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        bw_limit_kbps: Number(e.target.value),
                      })
                    }
                    className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 mb-1 font-medium">
                  Phân vùng Synology NAS chỉ định
                </label>
                <select
                  value={form.assigned_volume_id}
                  onChange={(e) =>
                    setForm({ ...form, assigned_volume_id: e.target.value })
                  }
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                >
                  <option value="">Tự động gán Volume ACTIVE ưu tiên cao nhất</option>
                  {volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.mount_path}) — {v.status}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-950 border border-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_mock}
                  onChange={(e) =>
                    setForm({ ...form, is_mock: e.target.checked })
                  }
                  className="mt-0.5 shrink-0 rounded border-slate-700"
                />
                <span className="text-slate-300">
                  Chế độ <strong>Demo Mô phỏng (Mock Adapter)</strong> — Dùng để chạy thử luồng Backup/Restore/Diff trên máy Local không cần SSH thật.
                </span>
              </label>

              <div>
                <label className="block text-slate-300 mb-1 font-medium">
                  Mẫu loại trừ file riêng cho VPS này (Tùy chọn — mỗi dòng 1 mẫu)
                </label>
                <textarea
                  rows={3}
                  value={form.custom_excludes}
                  onChange={(e) =>
                    setForm({ ...form, custom_excludes: e.target.value })
                  }
                  placeholder={
                    'Ví dụ:\nwp-content/uploads/wc-logs/\nbackup-*.zip'
                  }
                  className="w-full bg-slate-950 border border-slate-700 focus:border-blue-500 rounded-lg px-3 py-2 text-white font-mono text-xs outline-none"
                />
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                  Các mẫu đường dẫn tại đây sẽ được tự động gộp chung với{' '}
                  <Link
                    href="/settings"
                    className="text-cyan-400 hover:underline"
                  >
                    Bộ lọc loại trừ toàn cục (Global Exclude Rules)
                  </Link>{' '}
                  khi chạy Rsync cho VPS này.
                </p>
              </div>

              <div>
                <label className="block text-slate-300 mb-1 font-medium">
                  Ghi chú kỹ thuật
                </label>
                <input
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Ghi chú cụm máy chủ, datacenter..."
                  className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                />
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowServerModal(false)}
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="w-full sm:w-auto min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold"
                >
                  Lưu Cấu hình VPS
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* SSH Key Manager Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-4 sm:p-6 space-y-5 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>Quản lý Cặp Khóa SSH Kết nối VPS (/root/.ssh)</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tạo khóa Ed25519 trên NAS và copy lệnh cài đặt Public Key dán lên VPS trong 5 giây.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowKeyModal(false)}
                aria-label="Đóng"
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleGenerateKey}
              className="flex flex-col sm:flex-row gap-2.5 bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-xs"
            >
              <input
                required
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Tên file key (VD: nas_sync_ed25519)"
                className="flex-1 min-w-0 min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
              />
              <select
                value={keyType}
                onChange={(e) =>
                  setKeyType(e.target.value as 'ed25519' | 'rsa')
                }
                className="min-h-[42px] bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white"
              >
                <option value="ed25519">Ed25519 (Khuyên dùng)</option>
                <option value="rsa">RSA 4096-bit</option>
              </select>
              <button
                type="submit"
                disabled={generatingKey}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-semibold whitespace-nowrap"
              >
                {generatingKey ? 'Đang tạo...' : '+ Sinh Khóa SSH Mới'}
              </button>
            </form>

            <div className="space-y-3">
              {sshKeys.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
                  Chưa có SSH Key nào được tạo trên giao diện. Nhấn nút &quot;+ Sinh Khóa SSH Mới&quot; phía trên.
                </div>
              ) : (
                sshKeys.map((k) => (
                  <div
                    key={k.id}
                    className="p-3.5 sm:p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5 text-xs"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
                      <div className="min-w-0 space-y-0.5">
                        <div className="font-semibold text-white break-words">
                          {k.name}
                        </div>
                        <div className="text-[11px] text-slate-400 font-mono break-all">
                          {k.private_key_path}
                        </div>
                        {k.fingerprint && (
                          <div className="text-[11px] text-slate-500 font-mono break-all">
                            {k.fingerprint}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => void copyCommand(k)}
                        className="w-full sm:w-auto justify-center min-h-[38px] shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/20 text-blue-300 border border-blue-500/30 hover:bg-blue-600 hover:text-white transition-colors"
                      >
                        <Copy className="w-3.5 h-3.5 shrink-0" />
                        {copiedId === k.id
                          ? 'Đã copy lệnh cài VPS!'
                          : 'Copy lệnh gán lên VPS'}
                      </button>
                    </div>
                    <pre className="p-2.5 rounded bg-slate-900 text-[11px] text-slate-300 overflow-x-auto whitespace-pre-wrap break-all font-mono">
                      {k.public_key}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Test SSH & Panel Discovery Modal */}
      {testingServer && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-4 sm:p-6 space-y-4 max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm sm:text-base font-bold text-white break-all">
                Kiểm tra SSH & Quét Tự động {testingServer.panel_type} —{' '}
                {testingServer.hostname}
              </h3>
              <button
                type="button"
                onClick={() => setTestingServer(null)}
                aria-label="Đóng"
                className="h-10 w-10 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {testLoading ? (
              <div className="py-12 text-center text-xs text-slate-400">
                Đang kết nối SSH và đọc dữ liệu cấu hình {testingServer.panel_type}...
              </div>
            ) : testResult?.ok ? (
              <div className="space-y-4 text-xs">
                <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-start sm:items-center gap-2 min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5 sm:mt-0" />
                    <span className="break-words">
                      Kết nối SSH thành công ({testResult.ssh?.osInfo}) — Độ trễ:{' '}
                      {testResult.ssh?.latencyMs}ms
                    </span>
                  </div>
                  <span className="font-mono text-[11px] shrink-0">
                    {testResult.ssh?.uptime}
                  </span>
                </div>

                <div>
                  <div className="font-semibold text-slate-200 mb-2">
                    Danh sách Website, Subdomain & MySQL Database tự động phát hiện (
                    {testResult.domains?.length || 0} websites —{' '}
                    {(testResult.domains || []).filter((d) => d.isSubdomain).length}{' '}
                    subdomains):
                  </div>
                  <div className="border border-slate-800 rounded-xl overflow-hidden">
                    {/* Mobile Domain Card List (< sm) */}
                    <div className="sm:hidden divide-y divide-slate-800">
                      {(testResult.domains || []).map((d) => (
                        <div
                          key={d.domain}
                          className="p-3.5 space-y-2 bg-slate-950/40"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold text-white flex flex-wrap items-center gap-1.5 min-w-0">
                              <span className="break-all">{d.domain}</span>
                              {d.isSubdomain && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium shrink-0">
                                  SUB
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-[11px] text-cyan-300 px-2 py-0.5 rounded bg-slate-900 border border-slate-800 shrink-0">
                              {d.systemUser}
                            </span>
                          </div>

                          <div className="text-[11px] font-mono text-slate-400 break-all">
                            {d.webroot}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {d.databases.length === 0 ? (
                              <span className="text-[11px] text-slate-500">
                                Không dùng MySQL DB
                              </span>
                            ) : (
                              d.databases.map((db) => (
                                <span
                                  key={db.name}
                                  className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 font-mono text-[11px] break-all"
                                >
                                  {db.name}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Tablet/Desktop Table (>= sm) */}
                    <div className="hidden sm:block overflow-x-auto">
                      <table className="w-full min-w-[600px] text-left text-xs">
                        <thead className="bg-slate-950 text-slate-400">
                          <tr>
                            <th className="p-2.5">Domain / Subdomain</th>
                            <th className="p-2.5">System User</th>
                            <th className="p-2.5">Đường dẫn gốc trên VPS</th>
                            <th className="p-2.5">MySQL Databases</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {(testResult.domains || []).map((d) => (
                            <tr key={d.domain}>
                              <td className="p-2.5 font-semibold text-white">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span>{d.domain}</span>
                                  {d.isSubdomain && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium">
                                      SUB
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-2.5 font-mono text-cyan-300">
                                {d.systemUser}
                              </td>
                              <td className="p-2.5 font-mono text-slate-400">
                                {d.webroot}
                              </td>
                              <td className="p-2.5 text-emerald-300 font-mono">
                                {d.databases.map((db) => db.name).join(', ') ||
                                  '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-500/30 text-xs text-rose-200 break-words">
                ❌ Kết nối thất bại: {testResult?.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


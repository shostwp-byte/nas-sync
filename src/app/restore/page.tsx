'use client';

import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CheckCircle2,
  Database,
  Download,
  FolderSync,
  RotateCcw,
  Wrench,
} from 'lucide-react';
import { formatBytes, getPanelBadgeClass } from '@/lib/format';
import type { BackupItem, PanelType, RestoreMode, ServerRecord } from '@/types';

interface RestorableItem extends BackupItem {
  server_hostname: string;
  server_panel: string;
  volume_name: string;
  completed_at: string;
}

const PANEL_LABELS: Record<PanelType, string> = {
  DIRECTADMIN: 'DirectAdmin',
  CPANEL: 'cPanel / WHM',
  PLESK: 'Plesk Obsidian',
  AAPANEL: 'aaPanel / BT Panel',
  CYBERPANEL: 'CyberPanel (OpenLiteSpeed)',
  HESTIACP: 'HestiaCP',
  CLOUDPANEL: 'CloudPanel',
};

function getPanelDisplayLabel(panel?: string): string {
  if (!panel) return 'Unknown';
  return PANEL_LABELS[panel as PanelType] || panel;
}

function computePreviewWebroot(
  panel: string,
  user: string,
  domain: string
): string {
  switch (panel) {
    case 'DIRECTADMIN':
      return `/home/${user}/domains/${domain}/public_html`;
    case 'CPANEL':
      return `/home/${user}/public_html`;
    case 'PLESK':
      return `/var/www/vhosts/${domain}/httpdocs`;
    case 'AAPANEL':
      return `/www/wwwroot/${domain}`;
    case 'CYBERPANEL':
      return `/home/${domain}/public_html`;
    case 'HESTIACP':
      return `/home/${user}/web/${domain}/public_html`;
    case 'CLOUDPANEL':
      return `/home/${user}/htdocs/${domain}`;
    default:
      return `/home/${user}/domains/${domain}/public_html`;
  }
}

function RestoreContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectItemId = searchParams.get('itemId');
  const step2Ref = useRef<HTMLDivElement | null>(null);

  const [items, setItems] = useState<RestorableItem[]>([]);
  const [servers, setServers] = useState<ServerRecord[]>([]);
  const [filterQuery, setFilterQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<RestorableItem | null>(null);
  const [mode, setMode] = useState<RestoreMode>('FULL');
  const [targetServerId, setTargetServerId] = useState<number>(0);
  const [targetUser, setTargetUser] = useState('');
  const [targetDomain, setTargetDomain] = useState('');
  const [targetWebrootOverride, setTargetWebrootOverride] = useState('');
  const [selectedDbs, setSelectedDbs] = useState<string[]>([]);
  const [targetDbMap, setTargetDbMap] = useState<Record<string, string>>({});
  const [autoPatchConfig, setAutoPatchConfig] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const selectBackupItem = useCallback(
    (it: RestorableItem, scrollOnMobile = false) => {
      setSelectedItem(it);
      setTargetServerId(it.server_id);
      setTargetUser(it.system_user);
      setTargetDomain(it.domain_name);
      setTargetWebrootOverride('');
      setSelectedDbs(it.databases_list.map((d) => d.name));
      setTargetDbMap({});

      if (
        scrollOnMobile &&
        typeof window !== 'undefined' &&
        window.innerWidth < 1024
      ) {
        requestAnimationFrame(() => {
          step2Ref.current?.scrollIntoView({
            behavior: 'smooth',
            block: 'start',
          });
        });
      }
    },
    []
  );

  const loadData = useCallback(async () => {
    const [rRes, sRes] = await Promise.all([
      fetch('/api/restore'),
      fetch('/api/servers'),
    ]);
    const rList: RestorableItem[] = rRes.ok
      ? (await rRes.json()).items || []
      : [];
    const sList: ServerRecord[] = sRes.ok
      ? (await sRes.json()).servers || []
      : [];

    setItems(rList);
    setServers(sList);

    if (rList.length > 0) {
      const found = preselectItemId
        ? rList.find((x) => x.id === Number(preselectItemId)) || rList[0]
        : rList[0];
      selectBackupItem(found, Boolean(preselectItemId));
    }
  }, [preselectItemId, selectBackupItem]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const targetServer = servers.find((s) => s.id === targetServerId);
  const isCrossPanel =
    selectedItem &&
    targetServer &&
    (selectedItem.server_id !== targetServer.id ||
      selectedItem.server_panel !== targetServer.panel_type);

  const previewWebroot = targetServer
    ? targetWebrootOverride ||
      computePreviewWebroot(
        targetServer.panel_type,
        targetUser || 'user',
        targetDomain || 'domain.com'
      )
    : '';

  const handleExecuteRestore = async () => {
    if (!selectedItem || !targetServerId) return;
    if (
      !confirm(
        `Xác nhận khôi phục (${mode}) cho website "${targetDomain}" lên máy chủ "${targetServer?.hostname}" (${targetServer?.panel_type})?`
      )
    )
      return;

    setSubmitting(true);
    try {
      const cleanedDbMap: Record<string, string> = {};
      for (const [srcDb, dstDb] of Object.entries(targetDbMap)) {
        const trimmed = dstDb.trim();
        if (trimmed && trimmed !== srcDb && selectedDbs.includes(srcDb)) {
          cleanedDbMap[srcDb] = trimmed;
        }
      }

      const resp = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceJobId: selectedItem.job_id,
          backupItemId: selectedItem.id,
          mode,
          targetServerId,
          targetSystemUser: targetUser,
          targetDomainName: targetDomain,
          targetWebrootOverride: targetWebrootOverride || undefined,
          selectedDatabases: selectedDbs,
          targetDbMap:
            Object.keys(cleanedDbMap).length > 0 ? cleanedDbMap : undefined,
          autoPatchConfig,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        alert(json.error || 'Khôi phục thất bại');
        return;
      }
      router.push('/jobs');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredItems = items.filter(
    (it) =>
      it.domain_name.toLowerCase().includes(filterQuery.toLowerCase()) ||
      it.server_hostname.toLowerCase().includes(filterQuery.toLowerCase()) ||
      it.snapshot_name.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
          <RotateCcw className="w-5 h-5 text-blue-400 shrink-0" />
          <span>
            Khôi phục Đa năng & Di chuyển Chéo (Cross-Panel Migration)
          </span>
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Khôi phục riêng lẻ Mã nguồn, Database (MySQL / PostgreSQL) hoặc di chuyển trực tiếp Website giữa DirectAdmin, cPanel, Plesk, aaPanel, CyberPanel, HestiaCP và CloudPanel.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-10 text-center text-xs text-slate-400">
          Chưa có bản sao lưu hoàn tất nào trên NAS. Hãy chạy ít nhất 1 phiên sao lưu tại mục{' '}
          <strong className="text-white">Tổng quan</strong> hoặc{' '}
          <strong className="text-white">Máy chủ VPS</strong> trước khi thực hiện Restore!
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Bước 1: Chọn bản sao lưu nguồn */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-4 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white">
                1. Chọn Bản Sao lưu Nguồn
              </h3>
              <span className="text-[11px] text-slate-400 shrink-0">
                {filteredItems.length} bản ghi
              </span>
            </div>

            <input
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Tìm theo tên miền, VPS hoặc ngày snapshot..."
              className="w-full min-h-[42px] bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
            />

            <div className="space-y-2 max-h-72 lg:max-h-[500px] overflow-y-auto pr-1">
              {filteredItems.map((it) => {
                const isSelected = selectedItem?.id === it.id;
                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => selectBackupItem(it, true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectBackupItem(it, true);
                      }
                    }}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all text-xs space-y-1.5 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                      isSelected
                        ? 'bg-blue-600/15 border-blue-500 text-white'
                        : 'bg-slate-950/80 border-slate-800 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-sm text-white flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className="break-all">{it.domain_name}</span>
                        {it.is_subdomain === 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30 font-medium shrink-0">
                            SUB
                          </span>
                        )}
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {it.verification_status === 'PASSED' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shrink-0 whitespace-nowrap">
                            Verified ✅
                          </span>
                        )}
                        <a
                          href={`/api/explorer/archive?jobId=${it.job_id}&domain=${encodeURIComponent(
                            it.domain_name
                          )}`}
                          onClick={(e) => e.stopPropagation()}
                          title={`Tải gói ${it.domain_name} (.tar.gz)`}
                          className="inline-flex items-center gap-1 px-2 py-0.5 min-h-[24px] rounded bg-emerald-600/15 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 text-[10px] font-medium whitespace-nowrap transition-colors"
                        >
                          <Download className="w-3 h-3 shrink-0" />
                          <span>Tải .tar.gz</span>
                        </a>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                      <span
                        title={getPanelDisplayLabel(it.server_panel)}
                        className={`px-1.5 py-0.5 rounded border text-[10px] shrink-0 ${getPanelBadgeClass(
                          it.server_panel
                        )}`}
                      >
                        {getPanelDisplayLabel(it.server_panel)}
                      </span>
                      <span className="break-all">{it.server_hostname}</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-slate-500 font-mono">
                      <span className="break-all">Snap: {it.snapshot_name}</span>
                      <span className="shrink-0">
                        {formatBytes(it.webroot_size_bytes)} •{' '}
                        {it.databases_list.length} DB
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Bước 2 & 3: Chế độ & Máy chủ Đích */}
          <div
            ref={step2Ref}
            className="lg:col-span-7 scroll-mt-20 bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-6 text-xs min-w-0"
          >
            {selectedItem && (
              <>
                <div className="space-y-3">
                  <h3 className="text-sm font-bold text-white">
                    2. Chọn Chế độ Khôi phục
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      {
                        key: 'FULL' as RestoreMode,
                        title: 'Toàn bộ (Code + DB)',
                        desc: 'Khôi phục đầy đủ mã nguồn & nạp lại MySQL / PostgreSQL',
                        icon: RotateCcw,
                      },
                      {
                        key: 'FILES_ONLY' as RestoreMode,
                        title: 'Chỉ Mã nguồn (Files)',
                        desc: 'Rsync public_html & tự động chown quyền',
                        icon: FolderSync,
                      },
                      {
                        key: 'DB_ONLY' as RestoreMode,
                        title: 'Chỉ Database (SQL)',
                        desc: 'Giải nén luồng zstdcat qua SSH vào MySQL / PostgreSQL',
                        icon: Database,
                      },
                    ].map((opt) => {
                      const Icon = opt.icon;
                      const active = mode === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setMode(opt.key)}
                          className={`p-3.5 rounded-xl border text-left space-y-1 transition-all ${
                            active
                              ? 'bg-blue-600/20 border-blue-500 text-white'
                              : 'bg-slate-950 border-slate-800 text-slate-400 hover:border-slate-700'
                          }`}
                        >
                          <div className="font-semibold flex items-center gap-1.5 text-white">
                            <Icon className="w-4 h-4 text-blue-400 shrink-0" />
                            <span>{opt.title}</span>
                          </div>
                          <p className="text-[11px] opacity-80">{opt.desc}</p>
                        </button>
                      );
                    })}
                  </div>

                  {(mode === 'FULL' || mode === 'DB_ONLY') &&
                    selectedItem.databases_list.length > 0 && (
                      <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2.5">
                        <div className="font-medium text-slate-300">
                          Chọn Database cần khôi phục & ánh xạ tên DB đích (tùy chọn):
                        </div>
                        <div className="space-y-2">
                          {selectedItem.databases_list.map((d) => {
                            const isChecked = selectedDbs.includes(d.name);
                            const isPg =
                              d.engine === 'POSTGRESQL' ||
                              Boolean(d.file?.startsWith('pg_'));
                            return (
                              <div
                                key={d.name}
                                className="flex flex-col sm:flex-row sm:items-center gap-2"
                              >
                                <label className="inline-flex items-start sm:items-center gap-2 text-cyan-300 font-mono cursor-pointer min-w-0 sm:w-1/2 flex-wrap">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={(e) => {
                                      setSelectedDbs((prev) =>
                                        e.target.checked
                                          ? [...prev, d.name]
                                          : prev.filter((x) => x !== d.name)
                                      );
                                    }}
                                    className="mt-0.5 sm:mt-0 shrink-0"
                                  />
                                  <span className="break-all">
                                    {d.name} ({formatBytes(d.size_bytes)})
                                  </span>
                                  {isPg ? (
                                    <span className="px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/35 text-[10px] font-sans font-semibold shrink-0">
                                      PostgreSQL
                                    </span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-sans font-medium shrink-0">
                                      MySQL/MariaDB
                                    </span>
                                  )}
                                </label>
                                {isChecked && (
                                  <input
                                    type="text"
                                    value={targetDbMap[d.name] || ''}
                                    onChange={(e) =>
                                      setTargetDbMap((prev) => ({
                                        ...prev,
                                        [d.name]: e.target.value,
                                      }))
                                    }
                                    placeholder={`Đích: ${d.name} (để trống nếu giữ nguyên)`}
                                    className="w-full sm:w-1/2 min-h-[36px] bg-slate-900 border border-slate-800 focus:border-blue-500 rounded-lg px-2.5 py-1.5 text-[11px] text-white font-mono outline-none"
                                  />
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-bold text-white">
                      3. Cấu hình Máy chủ Đích & Chuẩn hóa Panel
                    </h3>
                    {isCrossPanel && (
                      <span className="px-2.5 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold text-[11px]">
                        ⚡ Cross-Panel Migration (
                        {getPanelDisplayLabel(selectedItem.server_panel)} ➔{' '}
                        {getPanelDisplayLabel(targetServer?.panel_type)})
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-300 mb-1 font-medium">
                        Máy chủ VPS Đích
                      </label>
                      <select
                        value={targetServerId}
                        onChange={(e) => {
                          const nextId = Number(e.target.value);
                          setTargetServerId(nextId);
                          const nextSrv = servers.find((s) => s.id === nextId);
                          if (nextSrv?.panel_type === 'AAPANEL') {
                            setTargetUser('www');
                          } else {
                            setTargetUser(selectedItem.system_user);
                          }
                        }}
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white"
                      >
                        {servers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.hostname} ({getPanelDisplayLabel(s.panel_type)}){' '}
                            {s.id === selectedItem.server_id
                              ? '— Máy chủ gốc'
                              : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-300 mb-1 font-medium">
                        System User trên Máy chủ Đích
                      </label>
                      <input
                        value={targetUser}
                        onChange={(e) => setTargetUser(e.target.value)}
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-300 mb-1 font-medium">
                        Domain Đích
                      </label>
                      <input
                        value={targetDomain}
                        onChange={(e) => setTargetDomain(e.target.value)}
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                    <div className="flex flex-col justify-between">
                      <label className="block text-slate-300 mb-1 font-medium">
                        Ghi đè Đường dẫn Webroot (Tùy chọn)
                      </label>
                      <input
                        value={targetWebrootOverride}
                        onChange={(e) =>
                          setTargetWebrootOverride(e.target.value)
                        }
                        placeholder={previewWebroot}
                        className="w-full min-h-[42px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
                      />
                    </div>
                  </div>

                  {/* Preview Mapping Box */}
                  <div className="p-3.5 sm:p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2 font-mono text-[11px] min-w-0">
                    <div className="text-slate-400 font-sans font-semibold">
                      Xem trước Ánh xạ Đường dẫn & Phân quyền Tự động:
                    </div>
                    <div className="space-y-1.5 text-slate-300">
                      <div className="break-all">
                        <span className="text-slate-500 font-sans">
                          Nguồn (Snapshot):{' '}
                        </span>
                        <span className="text-cyan-400">
                          {selectedItem.source_webroot
                            ? `NAS:/.../${selectedItem.snapshot_name}/home/domains/${selectedItem.domain_name} (${selectedItem.source_webroot})`
                            : `NAS:/.../${selectedItem.snapshot_name}/home/domains/${selectedItem.domain_name}`}
                        </span>
                      </div>
                      <div className="break-all">
                        <span className="text-slate-500 font-sans">
                          Đích dự kiến:{' '}
                        </span>
                        <span className="text-emerald-400">
                          {targetServer?.hostname}:{previewWebroot}
                        </span>
                      </div>
                    </div>
                    <div className="text-slate-500 font-sans break-words">
                      Tự động chuẩn hóa chủ sở hữu file theo chuẩn{' '}
                      {targetServer?.panel_type} (User: {targetUser})
                    </div>
                  </div>

                  {mode !== 'DB_ONLY' && (
                    <label className="flex items-start gap-3 p-3.5 sm:p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 cursor-pointer transition-colors hover:bg-emerald-500/15">
                      <input
                        type="checkbox"
                        checked={autoPatchConfig}
                        onChange={(e) => setAutoPatchConfig(e.target.checked)}
                        className="mt-1 shrink-0 rounded border-emerald-500/50"
                      />
                      <div className="space-y-1 min-w-0">
                        <div className="font-semibold text-emerald-200 flex items-center gap-1.5 flex-wrap">
                          <Wrench className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          <span className="break-words">
                            Tự động cập nhật tên Database &amp; đường dẫn trong
                            wp-config.php / .env / configuration.php
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-300 leading-relaxed break-words">
                          Tự động tạo bản sao lưu gốc{' '}
                          <code className="font-mono text-amber-300">
                            .nas-sync.bak
                          </code>{' '}
                          (<code className="font-mono text-slate-200">chmod 600</code>)
                          trước khi đổi{' '}
                          <code className="font-mono text-cyan-300">DB_NAME</code>{' '}
                          (theo bảng ánh xạ DB) và đường dẫn vật lý cũ sang đường
                          dẫn mới trên VPS đích.
                        </p>
                      </div>
                    </label>
                  )}

                  <button
                    type="button"
                    onClick={() => void handleExecuteRestore()}
                    disabled={submitting}
                    className="w-full min-h-[48px] py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25 transition-all"
                  >
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span className="break-words">
                      {submitting
                        ? 'Đang khởi tạo tiến trình Khôi phục...'
                        : isCrossPanel
                        ? `Thực thi Di chuyển Chéo sang ${targetServer?.hostname} (${targetServer?.panel_type})`
                        : `Thực thi Khôi phục 1-Click lên ${targetServer?.hostname}`}
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RestorePage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-xs text-slate-400">
          Đang tải trình Khôi phục Đa năng...
        </div>
      }
    >
      <RestoreContent />
    </Suspense>
  );
}


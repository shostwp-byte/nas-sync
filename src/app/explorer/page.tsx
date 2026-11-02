'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Archive,
  ArrowLeft,
  Download,
  FileCode2,
  Folder,
  FolderGit2,
  GitCompare,
  Link2,
  X,
} from 'lucide-react';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { BackupJob } from '@/types';

interface ExplorerEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;
  hardLinkCount: number;
}

interface DiffChunk {
  type: 'added' | 'removed' | 'unchanged';
  value: string;
  count: number;
}

function ExplorerInner() {
  const searchParams = useSearchParams();
  const initialJobId = searchParams.get('jobId');

  const [completedJobs, setCompletedJobs] = useState<BackupJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<number>(0);
  const [compareJobId, setCompareJobId] = useState<number>(0);
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [mobilePane, setMobilePane] = useState<'tree' | 'viewer'>('tree');
  const [previewContent, setPreviewContent] = useState<{
    fileName: string;
    sizeBytes: number;
    hardLinkCount: number;
    isBinary: boolean;
    content: string;
  } | null>(null);

  const [diffMode, setDiffMode] = useState(false);
  const [diffData, setDiffData] = useState<{
    baseSnapshot: string;
    targetSnapshot: string;
    addedLines: number;
    removedLines: number;
    chunks: DiffChunk[];
  } | null>(null);

  const loadSnapshots = useCallback(async () => {
    const resp = await fetch('/api/jobs?jobType=BACKUP&status=COMPLETED');
    if (!resp.ok) return;
    const list: BackupJob[] = (await resp.json()).jobs || [];
    setCompletedJobs(list);

    if (list.length > 0) {
      const target = initialJobId
        ? list.find((j) => j.id === Number(initialJobId)) || list[0]
        : list[0];
      setSelectedJobId(target.id);

      const olderSameServer = list.find(
        (j) => j.server_id === target.server_id && j.id !== target.id
      );
      if (olderSameServer) {
        setCompareJobId(olderSameServer.id);
      }
    }
  }, [initialJobId]);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  const browsePath = useCallback(
    async (jobId: number, relPath: string) => {
      if (!jobId) return;
      const qs = new URLSearchParams({
        jobId: String(jobId),
        path: relPath,
      });
      const resp = await fetch(`/api/explorer?${qs.toString()}`);
      if (resp.ok) {
        const json = await resp.json();
        setCurrentPath(json.currentPath || '');
        setEntries(json.entries || []);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedJobId) {
      setSelectedFile('');
      setPreviewContent(null);
      setDiffData(null);
      setMobilePane('tree');
      void browsePath(selectedJobId, 'home/domains');
    }
  }, [selectedJobId, browsePath]);

  const openFile = async (relPath: string) => {
    setSelectedFile(relPath);
    setMobilePane('viewer');
    setDiffMode(false);
    setDiffData(null);
    const qs = new URLSearchParams({
      jobId: String(selectedJobId),
      path: relPath,
      preview: '1',
    });
    const resp = await fetch(`/api/explorer?${qs.toString()}`);
    if (resp.ok) {
      const json = await resp.json();
      setPreviewContent(json.preview);
    }
  };

  const closeFile = () => {
    setSelectedFile('');
    setPreviewContent(null);
    setDiffMode(false);
    setDiffData(null);
    setMobilePane('tree');
  };

  const runDiffCompare = async (baseId = compareJobId) => {
    if (!selectedFile || !selectedJobId || !baseId) return;
    setDiffMode(true);
    const qs = new URLSearchParams({
      baseJobId: String(baseId),
      targetJobId: String(selectedJobId),
      path: selectedFile,
    });
    const resp = await fetch(`/api/explorer/diff?${qs.toString()}`);
    const json = await resp.json();
    if (resp.ok) {
      setDiffData(json.diff);
    } else {
      alert(json.error || 'Không thể so sánh Diff');
    }
  };

  const goParentDirectory = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    void browsePath(selectedJobId, parts.join('/'));
  };

  const currentJob = completedJobs.find((j) => j.id === selectedJobId);
  const siblingSnapshots = completedJobs.filter(
    (j) =>
      currentJob && j.server_id === currentJob.server_id && j.id !== currentJob.id
  );
  const selectedFileName = selectedFile.split('/').filter(Boolean).pop() || selectedFile;

  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <div className="min-w-0">
        <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
          <FolderGit2 className="w-5 h-5 text-cyan-400 shrink-0" />
          <span>Web File Explorer & Công cụ So sánh Mã nguồn (Diff Viewer)</span>
        </h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Duyệt trực tiếp cây thư mục chuẩn hóa trên NAS, tải lẻ từng file hoặc kiểm tra dòng code vừa bị sửa/thêm giữa 2 bản Snapshot.
        </p>
      </div>

      {completedJobs.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-10 text-center text-xs text-slate-400">
          Chưa có bản Snapshot nào để duyệt. Hãy chạy 2 phiên Backup liên tiếp trên cùng 1 máy chủ để trải nghiệm tính năng Hard-Link & Diff Viewer!
        </div>
      ) : (
        <>
          {/* Top Snapshot Selector Bar */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 sm:p-4 min-w-0 overflow-hidden flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto min-w-0 flex-1">
              <span className="text-slate-400 shrink-0 font-medium">
                Snapshot đang duyệt:
              </span>
              <select
                value={selectedJobId}
                onChange={(e) => {
                  const jid = Number(e.target.value);
                  setSelectedJobId(jid);
                  const jobObj = completedJobs.find((x) => x.id === jid);
                  const sib = completedJobs.find(
                    (x) =>
                      jobObj && x.server_id === jobObj.server_id && x.id !== jid
                  );
                  setCompareJobId(sib?.id || 0);
                }}
                className="w-full max-w-full min-w-0 truncate min-h-[40px] bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
              >
                {completedJobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    #{j.id} • {j.server_hostname} • {j.snapshot_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full lg:w-auto lg:max-w-[55%] min-w-0">
              <div className="w-full sm:flex-1 min-w-0 min-h-[40px] flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <div className="w-full min-w-0 truncate break-all font-mono text-cyan-400">
                  /{currentPath || ''}
                </div>
              </div>

              {selectedJobId > 0 && (
                <a
                  href={`/api/explorer/archive?jobId=${selectedJobId}&path=${encodeURIComponent(
                    currentPath
                  )}`}
                  title={
                    currentPath
                      ? `Tải thư mục /${currentPath} dạng .tar.gz`
                      : 'Tải toàn bộ Snapshot dạng .tar.gz'
                  }
                  className="w-full sm:w-auto justify-center min-h-[40px] shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white border border-emerald-500/30 font-semibold transition-colors"
                >
                  <Archive className="w-3.5 h-3.5 shrink-0" />
                  <span>Tải gói .tar.gz</span>
                </a>
              )}
            </div>
          </div>

          {/* Mobile Pane Switcher Tabs (< lg) */}
          <div className="lg:hidden grid grid-cols-2 gap-1.5 bg-slate-900 border border-slate-800 rounded-xl p-1 text-xs">
            <button
              type="button"
              onClick={() => setMobilePane('tree')}
              className={`min-h-[40px] px-3 py-2 rounded-lg font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${
                mobilePane === 'tree'
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="truncate">📁 Cây thư mục ({entries.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setMobilePane('viewer')}
              className={`min-h-[40px] px-3 py-2 rounded-lg font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${
                mobilePane === 'viewer'
                  ? 'bg-blue-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span className="truncate">📄 Xem File / Diff</span>
              {selectedFile && (
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              )}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-w-0">
            {/* Directory Tree */}
            <div
              className={`lg:col-span-4 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex-col min-w-0 h-[65dvh] min-h-[380px] lg:h-[580px] ${
                mobilePane === 'tree' ? 'flex' : 'hidden lg:flex'
              }`}
            >
              <div className="p-3.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-2 text-xs shrink-0">
                <div className="font-mono text-cyan-400 truncate min-w-0">
                  /{currentPath || ''}
                </div>
                {currentPath && (
                  <button
                    type="button"
                    onClick={goParentDirectory}
                    className="shrink-0 min-h-[34px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                  >
                    <ArrowLeft className="w-3.5 h-3.5 shrink-0" />
                    Lên 1 cấp
                  </button>
                )}
              </div>

              <div className="divide-y divide-slate-800/70 flex-1 overflow-y-auto text-xs min-h-0">
                {entries.length === 0 ? (
                  <div className="p-6 text-center text-slate-500">
                    Thư mục trống.
                  </div>
                ) : (
                  entries.map((entry) => (
                    <div
                      key={entry.relativePath}
                      onClick={() =>
                        entry.isDirectory
                          ? void browsePath(selectedJobId, entry.relativePath)
                          : void openFile(entry.relativePath)
                      }
                      className={`p-3 min-h-[46px] flex items-center justify-between cursor-pointer hover:bg-slate-800/50 transition-colors ${
                        selectedFile === entry.relativePath
                          ? 'bg-blue-600/15'
                          : ''
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {entry.isDirectory ? (
                          <Folder className="w-4 h-4 text-amber-400 shrink-0 fill-amber-400/20" />
                        ) : (
                          <FileCode2 className="w-4 h-4 text-blue-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-slate-100 font-medium truncate">
                            {entry.name}
                          </div>
                          <div className="text-[10px] text-slate-500">
                            {formatDateTime(entry.modifiedAt)}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {entry.isDirectory && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.location.href = `/api/explorer/archive?jobId=${selectedJobId}&path=${encodeURIComponent(
                                entry.relativePath
                              )}`;
                            }}
                            title="Tải thư mục này dạng .tar.gz"
                            aria-label={`Tải thư mục ${entry.name} dạng .tar.gz`}
                            className="h-7 w-7 shrink-0 inline-flex items-center justify-center rounded-md bg-slate-800/80 hover:bg-emerald-600 text-slate-300 hover:text-white border border-slate-700/80 hover:border-emerald-500 transition-colors"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {!entry.isDirectory && entry.hardLinkCount > 1 && (
                          <span
                            title={`Hard-linked (${entry.hardLinkCount} snapshots dùng chung inode, tốn 0 byte thêm)`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[10px]"
                          >
                            <Link2 className="w-3 h-3" />
                            HardLink
                          </span>
                        )}
                        {!entry.isDirectory && (
                          <span className="font-mono text-[11px] text-slate-400">
                            {formatBytes(entry.sizeBytes)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* File Preview & Diff Viewer */}
            <div
              className={`lg:col-span-8 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex-col min-w-0 h-[65dvh] min-h-[380px] lg:h-[580px] ${
                mobilePane === 'viewer' ? 'flex' : 'hidden lg:flex'
              }`}
            >
              {!selectedFile ? (
                <div className="p-8 sm:p-12 text-center text-xs text-slate-500 my-auto space-y-4">
                  <p>
                    Chọn một file bất kỳ trong cây thư mục (VD:{' '}
                    <code className="text-slate-300">index.php</code>,{' '}
                    <code className="text-slate-300">wp-config.php</code>,{' '}
                    <code className="text-slate-300">metadata.json</code> hoặc file{' '}
                    <code className="text-slate-300">.sql.gz</code>) để xem nội dung, tải lẻ hoặc so sánh Diff!
                  </p>
                  <button
                    type="button"
                    onClick={() => setMobilePane('tree')}
                    className="lg:hidden inline-flex items-center gap-1.5 px-4 py-2 min-h-[38px] rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700"
                  >
                    ← Mở Cây thư mục
                  </button>
                </div>
              ) : (
                <>
                  {/* Viewer Header */}
                  <div className="p-3.5 bg-slate-950 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs shrink-0">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setMobilePane('tree')}
                        className="lg:hidden min-h-[36px] px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 shrink-0 whitespace-nowrap"
                      >
                        ← Thư mục
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm text-white font-bold truncate">
                          {selectedFileName}
                        </div>
                        <div className="font-mono text-[11px] text-slate-400 break-all">
                          {selectedFile}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {siblingSnapshots.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            diffMode
                              ? setDiffMode(false)
                              : void runDiffCompare(compareJobId)
                          }
                          className={`min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-medium border transition-colors ${
                            diffMode
                              ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                              : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25'
                          }`}
                        >
                          <GitCompare className="w-3.5 h-3.5 shrink-0" />
                          {diffMode ? 'Xem gốc' : 'So sánh bản khác (Diff)'}
                        </button>
                      )}

                      <a
                        href={`/api/explorer/download?jobId=${selectedJobId}&path=${encodeURIComponent(
                          selectedFile
                        )}`}
                        className="min-h-[36px] inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
                      >
                        <Download className="w-3.5 h-3.5 shrink-0" />
                        Tải về
                      </a>

                      <button
                        type="button"
                        onClick={closeFile}
                        aria-label="Đóng file đang xem"
                        className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
                      >
                        <X className="w-3.5 h-3.5 shrink-0" />
                        Đóng
                      </button>
                    </div>
                  </div>

                  {/* Compare Snapshot Toolbar */}
                  {siblingSnapshots.length > 0 && (
                    <div className="px-3.5 py-2.5 bg-slate-900/90 border-b border-slate-800 flex flex-wrap items-center gap-2 text-xs shrink-0">
                      <select
                        value={compareJobId}
                        onChange={(e) => {
                          const nextId = Number(e.target.value);
                          setCompareJobId(nextId);
                          if (diffMode) void runDiffCompare(nextId);
                        }}
                        className="w-full sm:w-auto max-w-full min-w-0 flex-1 min-h-[38px] bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono truncate"
                      >
                        {siblingSnapshots.map((s) => (
                          <option key={s.id} value={s.id}>
                            So với: #{s.id} • {s.snapshot_name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => void runDiffCompare(compareJobId)}
                        className="w-full sm:w-auto justify-center min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 font-medium whitespace-nowrap transition-colors"
                      >
                        <GitCompare className="w-3.5 h-3.5 shrink-0" />
                        Chạy So sánh
                      </button>
                    </div>
                  )}

                  {diffMode && diffData ? (
                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="px-3.5 sm:px-4 py-2 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs shrink-0">
                        <span className="font-mono text-slate-400 break-all">
                          {diffData.baseSnapshot} ➔ {diffData.targetSnapshot}
                        </span>
                        <div className="flex items-center gap-3 font-mono shrink-0">
                          <span className="text-emerald-400">
                            +{diffData.addedLines} dòng thêm
                          </span>
                          <span className="text-rose-400">
                            -{diffData.removedLines} dòng xóa
                          </span>
                        </div>
                      </div>

                      <div className="flex-1 p-3.5 sm:p-4 font-mono text-xs overflow-auto bg-slate-950 min-h-0">
                        {diffData.addedLines === 0 &&
                        diffData.removedLines === 0 ? (
                          <div className="text-emerald-400 py-4 text-center font-sans">
                            ✅ Hai phiên bản giống hệt nhau 100% (Không có dòng code nào thay đổi).
                          </div>
                        ) : (
                          <div className="min-w-max w-full space-y-0.5">
                            {diffData.chunks.map((chunk, idx) => {
                              const lines = chunk.value
                                .replace(/\n$/, '')
                                .split('\n');
                              return lines.map((line, lIdx) => (
                                <div
                                  key={`${idx}-${lIdx}`}
                                  className={`px-2 py-0.5 rounded whitespace-pre ${
                                    chunk.type === 'added'
                                      ? 'bg-emerald-500/15 text-emerald-300'
                                      : chunk.type === 'removed'
                                      ? 'bg-rose-500/15 text-rose-300'
                                      : 'text-slate-400'
                                  }`}
                                >
                                  <span className="inline-block w-5 select-none opacity-70">
                                    {chunk.type === 'added'
                                      ? '+'
                                      : chunk.type === 'removed'
                                      ? '-'
                                      : ' '}
                                  </span>
                                  {line}
                                </div>
                              ));
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : previewContent?.isBinary ? (
                    <div className="p-8 sm:p-10 text-center text-xs text-slate-400 my-auto">
                      Đây là file nhị phân / nén ({formatBytes(previewContent.sizeBytes)}). Nhấn nút{' '}
                      <strong className="text-white">Tải về</strong> ở thanh công cụ phía trên để tải về máy.
                    </div>
                  ) : (
                    <pre className="flex-1 p-3.5 sm:p-4 font-mono text-xs text-slate-200 bg-slate-950 overflow-auto leading-relaxed min-h-0">
                      {previewContent?.content || ''}
                    </pre>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ExplorerPage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-xs text-slate-400">
          Đang tải trình duyệt File Explorer & Diff Viewer...
        </div>
      }
    >
      <ExplorerInner />
    </Suspense>
  );
}


'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Download,
  FileCode2,
  Folder,
  FolderGit2,
  GitCompare,
  Link2,
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
      void browsePath(selectedJobId, 'home/domains');
    }
  }, [selectedJobId, browsePath]);

  const openFile = async (relPath: string) => {
    setSelectedFile(relPath);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <FolderGit2 className="w-5 h-5 text-cyan-400" />
            Web File Explorer & Công cụ So sánh Mã nguồn (Diff Viewer)
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Duyệt trực tiếp cây thư mục chuẩn hóa trên NAS, tải lẻ từng file hoặc kiểm tra dòng code vừa bị sửa/thêm giữa 2 bản Snapshot.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <span className="text-slate-400">Snapshot đang duyệt:</span>
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
            className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white font-mono"
          >
            {completedJobs.map((j) => (
              <option key={j.id} value={j.id}>
                #{j.id} • {j.server_hostname} • {j.snapshot_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {completedJobs.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center text-xs text-slate-400">
          Chưa có bản Snapshot nào để duyệt. Hãy chạy 2 phiên Backup liên tiếp trên cùng 1 máy chủ để trải nghiệm tính năng Hard-Link & Diff Viewer!
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Directory Tree */}
          <div className="lg:col-span-5 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
            <div className="p-3.5 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-2 text-xs">
              <div className="font-mono text-cyan-400 truncate">
                /{currentPath || ''}
              </div>
              {currentPath && (
                <button
                  onClick={goParentDirectory}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Lên 1 cấp
                </button>
              )}
            </div>

            <div className="divide-y divide-slate-800/70 max-h-[540px] overflow-y-auto text-xs">
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
                    className={`p-3 flex items-center justify-between cursor-pointer hover:bg-slate-800/50 transition-colors ${
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
                      <div className="truncate">
                        <div className="text-slate-100 font-medium truncate">
                          {entry.name}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {formatDateTime(entry.modifiedAt)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-2">
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
          <div className="lg:col-span-7 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col">
            {!selectedFile ? (
              <div className="p-12 text-center text-xs text-slate-500 my-auto">
                Chọn một file bất kỳ bên trái (VD:{' '}
                <code className="text-slate-300">index.php</code>,{' '}
                <code className="text-slate-300">wp-config.php</code>,{' '}
                <code className="text-slate-300">metadata.json</code> hoặc file{' '}
                <code className="text-slate-300">.sql.gz</code>) để xem nội dung, tải lẻ hoặc so sánh Diff!
              </div>
            ) : (
              <>
                <div className="p-3.5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="font-mono text-white font-semibold truncate">
                    {selectedFile}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {siblingSnapshots.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={compareJobId}
                          onChange={(e) => {
                            const nextId = Number(e.target.value);
                            setCompareJobId(nextId);
                            if (diffMode) void runDiffCompare(nextId);
                          }}
                          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 font-mono"
                        >
                          {siblingSnapshots.map((s) => (
                            <option key={s.id} value={s.id}>
                              So với: {s.snapshot_name}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() =>
                            diffMode
                              ? setDiffMode(false)
                              : void runDiffCompare(compareJobId)
                          }
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded font-medium border ${
                            diffMode
                              ? 'bg-cyan-500 text-slate-950 border-cyan-400'
                              : 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30 hover:bg-cyan-500/25'
                          }`}
                        >
                          <GitCompare className="w-3.5 h-3.5" />
                          {diffMode ? 'Xem gốc' : 'So sánh Diff'}
                        </button>
                      </div>
                    )}

                    <a
                      href={`/api/explorer/download?jobId=${selectedJobId}&path=${encodeURIComponent(
                        selectedFile
                      )}`}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Tải file
                    </a>
                  </div>
                </div>

                {diffMode && diffData ? (
                  <div className="flex-1 flex flex-col">
                    <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between text-xs">
                      <span className="font-mono text-slate-400">
                        {diffData.baseSnapshot} ➔ {diffData.targetSnapshot}
                      </span>
                      <div className="flex items-center gap-3 font-mono">
                        <span className="text-emerald-400">
                          +{diffData.addedLines} dòng thêm
                        </span>
                        <span className="text-rose-400">
                          -{diffData.removedLines} dòng xóa
                        </span>
                      </div>
                    </div>

                    <div className="p-4 font-mono text-xs overflow-auto max-h-[480px] bg-slate-950 space-y-0.5">
                      {diffData.addedLines === 0 &&
                      diffData.removedLines === 0 ? (
                        <div className="text-emerald-400 py-4 text-center font-sans">
                          ✅ Hai phiên bản giống hệt nhau 100% (Không có dòng code nào thay đổi).
                        </div>
                      ) : (
                        diffData.chunks.map((chunk, idx) => {
                          const lines = chunk.value.replace(/\n$/, '').split('\n');
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
                        })
                      )}
                    </div>
                  </div>
                ) : previewContent?.isBinary ? (
                  <div className="p-10 text-center text-xs text-slate-400">
                    Đây là file nhị phân / nén ({formatBytes(previewContent.sizeBytes)}). Nhấn nút{' '}
                    <strong className="text-white">Tải file</strong> ở góc phải để tải về máy.
                  </div>
                ) : (
                  <pre className="p-4 font-mono text-xs text-slate-200 bg-slate-950 overflow-auto max-h-[500px] leading-relaxed">
                    {previewContent?.content || ''}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
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


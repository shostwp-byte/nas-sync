import type { JobStatus, PanelType } from '@/types';

export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes || 0);
  if (b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(b) / Math.log(1024))
  );
  const val = b / Math.pow(1024, i);
  return `${val >= 100 ? val.toFixed(0) : val.toFixed(2)} ${units[i]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  const b = Number(bps || 0);
  if (b <= 0) return '—';
  return `${formatBytes(b)}/s`;
}

export function formatEta(seconds: number | null | undefined): string {
  const s = Number(seconds || 0);
  if (s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}g ${m}p ${sec}s`;
  if (m > 0) return `${m}p ${sec}s`;
  return `${sec}s`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Chưa có';
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function getPanelBadgeClass(panel?: PanelType | string): string {
  switch (panel) {
    case 'DIRECTADMIN':
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
    case 'CPANEL':
      return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
    case 'PLESK':
      return 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30';
    case 'AAPANEL':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    default:
      return 'bg-slate-700/40 text-slate-300 border-slate-600';
  }
}

export function getJobStatusMeta(status: JobStatus | string): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'QUEUED':
      return {
        label: 'Đang chờ',
        className: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
      };
    case 'RUNNING':
      return {
        label: 'Đang chạy',
        className: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
      };
    case 'RESUMING':
      return {
        label: 'Đang nối tiếp',
        className: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
      };
    case 'VERIFYING':
      return {
        label: 'Kiểm định SQL',
        className: 'bg-violet-500/20 text-violet-300 border-violet-500/40',
      };
    case 'INTERRUPTED':
      return {
        label: 'Tạm ngắt (Auto-Retry)',
        className: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      };
    case 'COMPLETED':
      return {
        label: 'Hoàn tất',
        className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
      };
    case 'FAILED':
      return {
        label: 'Thất bại',
        className: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      };
    case 'CANCELLED':
      return {
        label: 'Đã hủy',
        className: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
      };
    default:
      return {
        label: status,
        className: 'bg-slate-700 text-slate-300 border-slate-600',
      };
  }
}


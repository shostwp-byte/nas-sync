import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { diffLines } from 'diff';
import { getDb } from '@/lib/db';

export interface ExplorerEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedAt: string;
  hardLinkCount: number;
}

export interface DiffChangeChunk {
  type: 'added' | 'removed' | 'unchanged';
  value: string;
  count: number;
}

export function resolveSafeSnapshotRoot(jobId: number): {
  snapshotRoot: string;
  hostname: string;
  snapshotName: string;
} {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT j.snapshot_name, s.hostname, v.mount_path
       FROM backup_jobs j
       JOIN servers s ON s.id = j.server_id
       JOIN storage_volumes v ON v.id = j.volume_id
       WHERE j.id = ?`
    )
    .get(jobId);

  if (!row) {
    throw new Error(`Không tìm thấy bản sao lưu Job #${jobId}`);
  }

  const snapshotRoot = path.resolve(
    String(row.mount_path),
    String(row.hostname),
    String(row.snapshot_name)
  );

  return {
    snapshotRoot,
    hostname: String(row.hostname),
    snapshotName: String(row.snapshot_name),
  };
}

export function resolveSafeSubPath(snapshotRoot: string, relativeSubPath = ''): string {
  const normalizedRel = relativeSubPath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(snapshotRoot, normalizedRel);

  if (
    resolved !== snapshotRoot &&
    !resolved.startsWith(snapshotRoot + path.sep)
  ) {
    throw new Error('Truy cập đường dẫn ngoài phạm vi Snapshot bị từ chối!');
  }

  return resolved;
}

export function listSnapshotDirectory(
  jobId: number,
  relativeSubPath = ''
): {
  hostname: string;
  snapshotName: string;
  currentPath: string;
  entries: ExplorerEntry[];
} {
  const { snapshotRoot, hostname, snapshotName } = resolveSafeSnapshotRoot(jobId);
  const targetDir = resolveSafeSubPath(snapshotRoot, relativeSubPath);

  if (!fs.existsSync(targetDir)) {
    return {
      hostname,
      snapshotName,
      currentPath: relativeSubPath,
      entries: [],
    };
  }

  const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
  const entries: ExplorerEntry[] = [];

  for (const d of dirents) {
    if (d.name === '.rsync-partial' || d.name === '.state.json') continue;
    const full = path.join(targetDir, d.name);
    const stat = fs.statSync(full);
    const rel = path
      .relative(snapshotRoot, full)
      .split(path.sep)
      .join('/');

    entries.push({
      name: d.name,
      relativePath: rel,
      isDirectory: d.isDirectory(),
      sizeBytes: d.isDirectory() ? 0 : stat.size,
      modifiedAt: stat.mtime.toISOString(),
      hardLinkCount: Number(stat.nlink || 1),
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    hostname,
    snapshotName,
    currentPath: relativeSubPath.replace(/^[/\\]+/, '').split(path.sep).join('/'),
    entries,
  };
}

export function readSnapshotFilePreview(
  jobId: number,
  relativeFilePath: string,
  maxBytes = 256 * 1024
): {
  fileName: string;
  sizeBytes: number;
  hardLinkCount: number;
  isBinary: boolean;
  truncated: boolean;
  content: string;
} {
  const { snapshotRoot } = resolveSafeSnapshotRoot(jobId);
  const fullPath = resolveSafeSubPath(snapshotRoot, relativeFilePath);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    throw new Error('File không tồn tại hoặc là thư mục.');
  }

  const stat = fs.statSync(fullPath);
  const fileName = path.basename(fullPath);

  // Tự động giải nén xem trước nếu là file .sql.gz nhỏ
  if (fileName.endsWith('.sql.gz') && stat.size < 2 * 1024 * 1024) {
    const raw = zlib.gunzipSync(fs.readFileSync(fullPath));
    const sliced = raw.subarray(0, maxBytes);
    return {
      fileName,
      sizeBytes: stat.size,
      hardLinkCount: Number(stat.nlink || 1),
      isBinary: false,
      truncated: raw.length > maxBytes,
      content: sliced.toString('utf8'),
    };
  }

  const fd = fs.openSync(fullPath, 'r');
  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  fs.readSync(fd, buf, 0, readLen, 0);
  fs.closeSync(fd);

  const hasNullByte = buf.includes(0);
  if (hasNullByte) {
    return {
      fileName,
      sizeBytes: stat.size,
      hardLinkCount: Number(stat.nlink || 1),
      isBinary: true,
      truncated: false,
      content: '',
    };
  }

  return {
    fileName,
    sizeBytes: stat.size,
    hardLinkCount: Number(stat.nlink || 1),
    isBinary: false,
    truncated: stat.size > maxBytes,
    content: buf.toString('utf8'),
  };
}

/**
 * Mục 9.5: So sánh Diff mã nguồn (dòng code nào vừa bị thêm/sửa/xóa) giữa 2 bản Snapshot
 */
export function compareSnapshotFilesDiff(
  baseJobId: number,
  targetJobId: number,
  relativeFilePath: string
): {
  relativeFilePath: string;
  baseSnapshot: string;
  targetSnapshot: string;
  addedLines: number;
  removedLines: number;
  chunks: DiffChangeChunk[];
} {
  const baseInfo = resolveSafeSnapshotRoot(baseJobId);
  const targetInfo = resolveSafeSnapshotRoot(targetJobId);

  const baseFile = resolveSafeSubPath(baseInfo.snapshotRoot, relativeFilePath);
  const targetFile = resolveSafeSubPath(targetInfo.snapshotRoot, relativeFilePath);

  const readTextSafe = (p: string): string => {
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return '';
    if (p.endsWith('.sql.gz')) {
      return zlib.gunzipSync(fs.readFileSync(p)).toString('utf8');
    }
    return fs.readFileSync(p, 'utf8');
  };

  const oldText = readTextSafe(baseFile);
  const newText = readTextSafe(targetFile);

  const rawDiff = diffLines(oldText, newText);
  let addedLines = 0;
  let removedLines = 0;

  const chunks: DiffChangeChunk[] = rawDiff.map((part) => {
    const lineCount = part.count || 0;
    if (part.added) {
      addedLines += lineCount;
      return { type: 'added', value: part.value, count: lineCount };
    }
    if (part.removed) {
      removedLines += lineCount;
      return { type: 'removed', value: part.value, count: lineCount };
    }
    return { type: 'unchanged', value: part.value, count: lineCount };
  });

  return {
    relativeFilePath,
    baseSnapshot: baseInfo.snapshotName,
    targetSnapshot: targetInfo.snapshotName,
    addedLines,
    removedLines,
    chunks,
  };
}


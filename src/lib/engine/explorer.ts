import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { diffLines } from 'diff';
import { getDb } from '@/lib/db';
import { isSafeSnapshotName } from './safe-names';

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

  const snapshotName = String(row.snapshot_name);
  if (!isSafeSnapshotName(snapshotName)) {
    throw new Error('Tên Snapshot không hợp lệ.');
  }

  const hostRoot = path.resolve(String(row.mount_path), String(row.hostname));
  const snapshotRoot = path.resolve(hostRoot, snapshotName);
  if (!isWithinRoot(hostRoot, snapshotRoot)) {
    throw new Error('Đường dẫn Snapshot không hợp lệ.');
  }

  return {
    snapshotRoot,
    hostname: String(row.hostname),
    snapshotName,
  };
}

function isWithinRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export function resolveSafeSubPath(snapshotRoot: string, relativeSubPath = ''): string {
  if (relativeSubPath.includes('\0')) {
    throw new Error('Đường dẫn chứa ký tự không hợp lệ.');
  }
  const normalizedRel = relativeSubPath.replace(/^[/\\]+/, '');
  const resolved = path.resolve(snapshotRoot, normalizedRel);

  if (!isWithinRoot(snapshotRoot, resolved)) {
    throw new Error('Truy cập đường dẫn ngoài phạm vi Snapshot bị từ chối!');
  }

  // Snapshot chứa symlink sao chép nguyên vẹn từ VPS (rsync -a). Một khách hàng hosting có thể tạo
  // symlink trỏ tới /root/.ssh/..., /app/data/... trong container NAS — phải kiểm tra đích thật.
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync(snapshotRoot);
    const realTarget = fs.realpathSync(resolved);
    if (!isWithinRoot(realRoot, realTarget)) {
      throw new Error('Symlink trỏ ra ngoài phạm vi Snapshot bị từ chối!');
    }
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

  const dirStat = fs.lstatSync(targetDir);
  if (!dirStat.isDirectory()) {
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

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }

    // Bỏ qua symlink và thiết bị đặc biệt (FIFO, socket, block/char device) để chống leo thang đặc quyền / treo luồng
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      continue;
    }

    const isDir = stat.isDirectory();
    const rel = path
      .relative(snapshotRoot, full)
      .split(path.sep)
      .join('/');

    entries.push({
      name: d.name,
      relativePath: rel,
      isDirectory: isDir,
      sizeBytes: isDir ? 0 : stat.size,
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

const MAX_GZ_PREVIEW_COMPRESSED_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_GZ_PREVIEW_UNCOMPRESSED_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIFF_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

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

  if (!fs.existsSync(fullPath)) {
    throw new Error('File không tồn tại.');
  }

  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile()) {
    throw new Error(
      'Chỉ hỗ trợ xem trước tập tin thông thường (không hỗ trợ thư mục/symlink/FIFO/device).'
    );
  }

  const safeMaxBytes = Math.min(
    Math.max(1024, Number(maxBytes) || 256 * 1024),
    1024 * 1024
  );
  const fileName = path.basename(fullPath);

  // Tự động giải nén an toàn cho file .gz / .sql.gz với giới hạn chống Gzip Bomb (OOM)
  if (fileName.endsWith('.gz')) {
    if (stat.size > MAX_GZ_PREVIEW_COMPRESSED_BYTES) {
      return {
        fileName,
        sizeBytes: stat.size,
        hardLinkCount: Number(stat.nlink || 1),
        isBinary: false,
        truncated: true,
        content:
          '...File nén quá lớn (> 5 MB) để giải nén trực tiếp trên RAM, vui lòng tải về máy để xem toàn bộ...',
      };
    }

    try {
      const raw = zlib.gunzipSync(fs.readFileSync(fullPath), {
        maxOutputLength: MAX_GZ_PREVIEW_UNCOMPRESSED_BYTES,
      });
      const sliced = raw.subarray(0, safeMaxBytes);
      if (sliced.includes(0)) {
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
        truncated: raw.length > safeMaxBytes,
        content: sliced.toString('utf8'),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
        return {
          fileName,
          sizeBytes: stat.size,
          hardLinkCount: Number(stat.nlink || 1),
          isBinary: false,
          truncated: true,
          content:
            '...Dữ liệu sau giải nén vượt ngưỡng an toàn RAM (10 MB), vui lòng tải file về máy để xem...',
        };
      }
      throw new Error(`Không thể giải nén tập tin xem trước: ${(err as Error).message}`);
    }
  }

  const readLen = Math.min(stat.size, safeMaxBytes);
  const buf = Buffer.alloc(readLen);
  const fd = fs.openSync(fullPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readLen, 0);
  } finally {
    fs.closeSync(fd);
  }

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
    truncated: stat.size > safeMaxBytes,
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
    if (!fs.existsSync(p)) return '';
    const stat = fs.lstatSync(p);
    if (!stat.isFile()) return '';
    if (stat.size > MAX_DIFF_FILE_BYTES) {
      throw new Error(
        'Tập tin vượt quá giới hạn 5 MB để so sánh Diff trực tiếp.'
      );
    }
    if (p.endsWith('.gz')) {
      try {
        return zlib
          .gunzipSync(fs.readFileSync(p), {
            maxOutputLength: MAX_DIFF_FILE_BYTES,
          })
          .toString('utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error(
            'Dữ liệu sau giải nén vượt quá giới hạn 5 MB để so sánh Diff trực tiếp.'
          );
        }
        throw err;
      }
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


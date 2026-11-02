import { NextResponse } from 'next/server';

const MAX_PUBLIC_ERROR_LENGTH = 360;

const RAW_SQLITE_INTERNAL_RE =
  /\b(?:SQLITE_(?:ERROR|CORRUPT|IOERR|CANTOPEN|MISUSE|BUSY|LOCKED|NOMEM|PROTOCOL|SCHEMA)|ERR_SQLITE_ERROR|DatabaseSync|StatementSync|near\s+"[^"]*":\s*syntax error|no such table:|no such column:)\b/i;

const SQLITE_UNIQUE_RE = /UNIQUE constraint failed:/i;

const POSIX_INTERNAL_PATH_RE =
  /(?:\/(?:app|root|mnt|volume\d+|var|etc|usr|tmp|opt|home|proc|sys))(?=[/\s"':;,)\]]|$)(?:\/[^\s"':;,)\]]*)*/g;

const WINDOWS_PATH_RE = /[A-Za-z]:(?:\\|\/)[^\s"':;,)\]]+/g;

const CPP_SOURCE_FRAME_RE = /\b[\w.-]+\.(?:cc|cpp|cxx|hpp|h):\d+(?::\d+)?\b/g;

/**
 * Làm sạch thông báo lỗi trước khi trả về HTTP JSON cho trình duyệt:
 * - Che giấu đường dẫn vật lý nội bộ (/app/..., /root/..., /mnt/..., /volume1/..., C:\...)
 * - Loại bỏ C++ SQLite stack trace và Node.js multi-line stack frames
 * - Giữ nguyên các thông báo lỗi nghiệp vụ tiếng Việt một dòng rõ ràng cho người dùng.
 */
export function sanitizeErrorMessage(
  err: unknown,
  fallback = 'Đã xảy ra lỗi hệ thống nội bộ.'
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : '';

  if (!raw || !raw.trim()) {
    return fallback;
  }

  if (SQLITE_UNIQUE_RE.test(raw)) {
    return 'Dữ liệu bị trùng lặp với bản ghi đã tồn tại trong hệ thống.';
  }

  if (RAW_SQLITE_INTERNAL_RE.test(raw)) {
    return fallback;
  }

  const meaningfulLines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        Boolean(line) &&
        !/^at\s+/.test(line) &&
        !/^NodeError:/i.test(line) &&
        !/^code:\s*['"]ERR_/i.test(line)
    );

  if (meaningfulLines.length === 0) {
    return fallback;
  }

  let cleaned = meaningfulLines[0]
    .replace(WINDOWS_PATH_RE, '[redacted-path]')
    .replace(POSIX_INTERNAL_PATH_RE, '[redacted-path]')
    .replace(CPP_SOURCE_FRAME_RE, '[internal]')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned || cleaned === '[redacted-path]' || cleaned === '[internal]') {
    return fallback;
  }

  if (cleaned.length > MAX_PUBLIC_ERROR_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_PUBLIC_ERROR_LENGTH - 1)}…`;
  }

  return cleaned;
}

export function safeErrorJson(
  err: unknown,
  fallback = 'Đã xảy ra lỗi hệ thống nội bộ.',
  status = 500
): NextResponse {
  if (status >= 500) {
    console.error('[NAS-Sync API Error]', err);
  }
  return NextResponse.json(
    {
      ok: false,
      error: sanitizeErrorMessage(err, fallback),
    },
    { status }
  );
}

export const DEFAULT_WORDPRESS_HOSTING_EXCLUDES = [
  'wp-content/cache/',
  'wp-content/litespeed/',
  'wp-content/updraft/',
  'wp-content/ai1wm-backups/*.wpress',
  'wp-content/backups-dup-pro/',
  'storage/logs/*.log',
  '*.log',
  'error_log',
  'core.[0-9]*',
].join('\n');

const MAX_INPUT_CHARS = 8192;
const MAX_PATTERN_LENGTH = 200;
const MAX_PATTERNS_COUNT = 100;
const FORBIDDEN_EXACT_PATTERNS = new Set(['/', '.', '..', '**', '/*', '/**']);

function isSingleExcludePatternSafe(pattern: string): {
  ok: boolean;
  reason?: string;
} {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `Mỗi quy tắc loại trừ phải dài từ 1 đến ${MAX_PATTERN_LENGTH} ký tự.`,
    };
  }
  if (/[\0\r\n]/.test(pattern)) {
    return {
      ok: false,
      reason: 'Quy tắc loại trừ chứa ký tự điều khiển không hợp lệ.',
    };
  }
  if (pattern.startsWith('-')) {
    return {
      ok: false,
      reason: `Quy tắc "${pattern}" không được bắt đầu bằng dấu gạch ngang "-".`,
    };
  }
  if (FORBIDDEN_EXACT_PATTERNS.has(pattern)) {
    return {
      ok: false,
      reason: `Quy tắc "${pattern}" quá rộng (có nguy cơ bỏ qua toàn bộ dữ liệu sao lưu) và đã bị chặn.`,
    };
  }
  const segments = pattern.split('/');
  if (segments.includes('..')) {
    return {
      ok: false,
      reason: `Quy tắc "${pattern}" không được chứa tham chiếu thư mục cha "..".`,
    };
  }
  return { ok: true };
}

export function parseSafeExcludePatterns(
  ...rawBlocks: Array<string | undefined | null>
): string[] {
  const unique = new Set<string>();

  for (const block of rawBlocks) {
    if (!block) continue;
    const lines = String(block).split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      if (!isSingleExcludePatternSafe(trimmed).ok) {
        continue;
      }
      unique.add(trimmed);
      if (unique.size >= MAX_PATTERNS_COUNT) {
        return Array.from(unique);
      }
    }
  }

  return Array.from(unique);
}

export function validateExcludePatternsInput(raw: string): {
  ok: boolean;
  normalized: string;
  error?: string;
} {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      normalized: '',
      error: 'Dữ liệu quy tắc loại trừ không hợp lệ.',
    };
  }

  if (raw.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      normalized: '',
      error: `Danh sách loại trừ vượt quá giới hạn ${MAX_INPUT_CHARS} ký tự.`,
    };
  }

  const lines = raw.split(/\r?\n/);
  const normalizedLines: string[] = [];
  const seenPatterns = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      if (trimmed.includes('\0') || trimmed.length > MAX_PATTERN_LENGTH) {
        return {
          ok: false,
          normalized: '',
          error: `Dòng ghi chú #${i + 1} quá dài hoặc chứa ký tự không hợp lệ.`,
        };
      }
      normalizedLines.push(trimmed);
      continue;
    }

    const check = isSingleExcludePatternSafe(trimmed);
    if (!check.ok) {
      return {
        ok: false,
        normalized: '',
        error: check.reason || `Quy tắc tại dòng ${i + 1} không hợp lệ.`,
      };
    }

    if (!seenPatterns.has(trimmed)) {
      seenPatterns.add(trimmed);
      if (seenPatterns.size > MAX_PATTERNS_COUNT) {
        return {
          ok: false,
          normalized: '',
          error: `Chỉ cho phép tối đa ${MAX_PATTERNS_COUNT} quy tắc loại trừ.`,
        };
      }
      normalizedLines.push(trimmed);
    }
  }

  return {
    ok: true,
    normalized: normalizedLines.join('\n'),
  };
}

import { Transform, type TransformCallback } from 'node:stream';

export interface SafePsqlStreamOptions {
  /**
   * Nếu truyền tên Role đích (không phải superuser), tự động bỏ qua câu lệnh
   * `COMMENT ON EXTENSION ...;` vốn chỉ chủ sở hữu extension mới chạy được.
   */
  nonSuperuserRole?: string;
  /**
   * Có lọc bỏ dòng `\restrict` / `\unrestrict` có sẵn bên trong tệp dump hay không
   * (mặc định `true` để bọc ngoài bằng khóa `\restrict <randomKey>` riêng của phiên nạp).
   */
  stripEmbeddedRestrictLines?: boolean;
  /**
   * Callback nhận số byte đã kiểm duyệt đi qua luồng (phục vụ Watchdog chống Idle Timeout giả)
   */
  onBytesTransferred?: (bytes: number) => void;
}

type PsqlLexState =
  | 'NORMAL'
  | 'SINGLE_QUOTE'
  | 'DOUBLE_QUOTE'
  | 'DOLLAR_QUOTE'
  | 'LINE_COMMENT'
  | 'BLOCK_COMMENT'
  | 'COPY_DATA';

const PG_RESTRICT_LINE_RE = /^\\(?:un)?restrict\s+[A-Za-z0-9_-]{1,128}$/;

const SAFE_STANDARD_CONFORMING_ON_RE =
  /^SET\s+(?:SESSION\s+|LOCAL\s+)?standard_conforming_strings\s*(?:=|TO)\s*(?:on|'on'|true|'true'|1)\s*;$/i;
const SAFE_CLIENT_ENCODING_UTF8_RE =
  /^SET\s+(?:SESSION\s+|LOCAL\s+)?client_encoding\s*(?:=|TO)\s*(?:'UTF8'|UTF8|'UNICODE'|UNICODE)\s*;$/i;
const SAFE_PG_DUMP_SEARCH_PATH_SET_CONFIG_RE =
  /^SELECT\s+(?:pg_catalog\.)?set_config\(\s*'search_path'\s*,\s*'(?:[A-Za-z0-9_,\s"$]*)'\s*,\s*(?:false|true)\s*\)\s*;$/i;

const FORBIDDEN_PG_STMT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\bCOPY\b[\s\S]*?\b(?:TO|FROM)\s+PROGRAM\b/i,
    reason:
      '[SECURITY] Phát hiện câu lệnh COPY ... PROGRAM nguy hiểm trong bản sao lưu PostgreSQL!',
  },
  {
    re: /\b(?:SET\s+(?:SESSION\s+|LOCAL\s+)?ROLE|RESET\s+ROLE|SET\s+(?:SESSION\s+|LOCAL\s+)?SESSION\s+AUTHORIZATION|RESET\s+SESSION\s+AUTHORIZATION|SESSION_AUTHORIZATION)\b/i,
    reason:
      '[SECURITY] Chặn thao tác thay đổi đặc quyền phiên (ROLE / SESSION_AUTHORIZATION) từ bên trong tệp dump SQL!',
  },
  {
    re: /\bBACKSLASH_QUOTE\b/i,
    reason:
      '[SECURITY] Không cho phép thay đổi tham số backslash_quote trong luồng khôi phục PostgreSQL!',
  },
  {
    re: /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i,
    reason:
      '[SECURITY] Chặn câu lệnh quản trị tài khoản cấp cụm (CREATE/ALTER/DROP ROLE/USER) trong bản sao lưu database!',
  },
  {
    re: /\bALTER\s+SYSTEM\b/i,
    reason:
      '[SECURITY] Chặn câu lệnh ALTER SYSTEM trong bản sao lưu PostgreSQL!',
  },
  {
    re: /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TRUSTED\s+)?(?:PROCEDURAL\s+)?LANGUAGE\b/i,
    reason:
      '[SECURITY] Chặn câu lệnh đăng ký ngôn ngữ thủ tục mới (CREATE LANGUAGE) trong luồng khôi phục SQL!',
  },
  {
    re: /\bLANGUAGE\s+['"]?(?:plperlu|plpythonu|plpython2u|plpython3u|pltclu|plsh|c)\b/i,
    reason:
      '[SECURITY] Chặn hàm sử dụng ngôn ngữ không an toàn (Untrusted PL / C) trong bản sao lưu PostgreSQL!',
  },
];

const COPY_FROM_STDIN_RE = /\bCOPY\b[\s\S]*?\bFROM\s+stdin\b/i;
const SINGLE_LINE_COMMENT_ON_EXTENSION_RE =
  /^COMMENT\s+ON\s+EXTENSION\s+(?:"[^"]+"|[A-Za-z0-9_]+)\s+IS\s+(?:NULL|'(?:''|[^'])*')\s*;(?:\s*--.*)?$/i;

function isIdentStart(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x5f || // _
    byte >= 0x80
  );
}

/**
 * S12 Fix: Trong PostgreSQL (`scan.l` / `psqlscan.l`), `ident_cont` bao gồm cả `$` (`0x24`),
 * trong khi `dolq_cont` không chứa `$`. Bám sát quy tắc này để `a$$x$` và `a$E'\'` được nhận diện
 * đúng là một định danh duy nhất giống hệt `psql`.
 */
function isIdentCont(byte: number): boolean {
  return (
    isIdentStart(byte) ||
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x24 // $
  );
}

function isAsciiDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/**
 * Bộ lọc luồng SQL phòng vệ chiều sâu cho PostgreSQL (`S1`, `S6`, `S12`, `N29`):
 * - Dùng kết hợp với cơ chế bắt buộc `\restrict` gốc của `psql` + kết nối trực tiếp bằng role của khách
 *   (hoặc định dạng `pg_dump -Fc` + `pg_restore`).
 * - Từ chối ký tự `\r` rời ngoài CRLF, từ chối mọi `client_encoding` khác UTF8/UNICODE, từ chối mọi
 *   thao tác đổi `standard_conforming_strings` / `session_authorization` / `set_config` ngoài `search_path`.
 * - Không giữ nội dung bên trong định danh kép `"..."` khi so khớp `COPY ... FROM stdin`.
 * - Hỗ trợ truyền thẳng dòng dữ liệu lớn hơn 64 MiB bên trong `COPY_DATA` mà không tràn RAM (`N29`).
 */
export function createSafePsqlRestoreTransform(
  options: SafePsqlStreamOptions = {}
): Transform {
  const stripRestrict = options.stripEmbeddedRestrictLines !== false;
  let state: PsqlLexState = 'NORMAL';
  let singleQuoteEscapeMode = false; // E'...'
  let dollarTag = ''; // Ví dụ "$$" hoặc "$body$"
  let blockCommentDepth = 0;

  let leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let copyLineOverflowing = false;
  let stmtPreview = '';
  let rawStmtText = '';
  let inIdentToken = false;
  let identTokenLen = 0;
  let lastIdentSingleByte = -1;
  let prevByteWasDigit = false;

  const MAX_STMT_PREVIEW = 8192;

  const appendStmtPreview = (ch: string) => {
    if (stmtPreview.length < MAX_STMT_PREVIEW) {
      stmtPreview += ch;
    } else {
      stmtPreview =
        stmtPreview.slice(0, 4096) + ' ' + stmtPreview.slice(-3072) + ch;
    }
  };

  const appendRawStmtChar = (ch: string) => {
    if (rawStmtText.length < MAX_STMT_PREVIEW) {
      rawStmtText += ch;
    } else {
      rawStmtText =
        rawStmtText.slice(0, 4096) + ' ' + rawStmtText.slice(-3072) + ch;
    }
  };

  const resetIdentTracking = () => {
    inIdentToken = false;
    identTokenLen = 0;
    lastIdentSingleByte = -1;
    prevByteWasDigit = false;
  };

  const assertStatementSafe = (previewText: string, rawText: string): void => {
    const trimmedPreview = previewText.trim();
    const trimmedRaw = rawText.trim();
    if (!trimmedPreview && !trimmedRaw) return;

    for (const rule of FORBIDDEN_PG_STMT_PATTERNS) {
      if (rule.re.test(trimmedPreview)) {
        throw new Error(rule.reason);
      }
    }

    if (
      /\bSTANDARD_CONFORMING_STRINGS\b/i.test(trimmedPreview) ||
      /\bSTANDARD_CONFORMING_STRINGS\b/i.test(trimmedRaw)
    ) {
      if (!SAFE_STANDARD_CONFORMING_ON_RE.test(trimmedRaw)) {
        throw new Error(
          '[SECURITY] Không cho phép thay đổi standard_conforming_strings trong luồng khôi phục PostgreSQL!'
        );
      }
    }

    if (
      /\bCLIENT_ENCODING\b/i.test(trimmedPreview) ||
      /\bCLIENT_ENCODING\b/i.test(trimmedRaw)
    ) {
      if (!SAFE_CLIENT_ENCODING_UTF8_RE.test(trimmedRaw)) {
        throw new Error(
          '[SECURITY] Chỉ cho phép client_encoding UTF8/UNICODE trong luồng khôi phục PostgreSQL!'
        );
      }
    }

    if (/\bSESSION_AUTHORIZATION\b/i.test(trimmedRaw)) {
      throw new Error(
        '[SECURITY] Phát hiện tham chiếu tới session_authorization bị cấm trong bản sao lưu PostgreSQL!'
      );
    }

    if (
      /\bSET_CONFIG\s*\(/i.test(trimmedPreview) ||
      /\bSET_CONFIG\s*\(/i.test(trimmedRaw)
    ) {
      if (!SAFE_PG_DUMP_SEARCH_PATH_SET_CONFIG_RE.test(trimmedRaw)) {
        throw new Error(
          '[SECURITY] Chặn lệnh gọi set_config(...) ngoài cấu hình search_path chuẩn của pg_dump!'
        );
      }
    }
  };

  const processLine = (
    rawLineWithNewline: Buffer,
    pushFn: (chunk: Buffer) => void
  ) => {
    if (options.onBytesTransferred && rawLineWithNewline.length > 0) {
      options.onBytesTransferred(rawLineWithNewline.length);
    }

    // 1. Bên trong khối dữ liệu COPY ... FROM stdin: chỉ kết thúc khi gặp đúng dòng `\.` ở đầu dòng
    if (state === 'COPY_DATA') {
      if (copyLineOverflowing) {
        copyLineOverflowing = false;
        pushFn(rawLineWithNewline);
        return;
      }

      let endIdx = rawLineWithNewline.length;
      if (endIdx > 0 && rawLineWithNewline[endIdx - 1] === 0x0a) endIdx--;
      if (endIdx > 0 && rawLineWithNewline[endIdx - 1] === 0x0d) endIdx--;

      if (
        endIdx === 2 &&
        rawLineWithNewline[0] === 0x5c && // '\'
        rawLineWithNewline[1] === 0x2e // '.'
      ) {
        state = 'NORMAL';
        resetIdentTracking();
      }
      pushFn(rawLineWithNewline);
      return;
    }

    // 2. Chặn tuyệt đối ký tự `\r` đơn lẻ (không đi ngay trước `\n`) để không lệch trạng thái dòng với psqlscan.l
    for (let k = 0; k < rawLineWithNewline.length; k++) {
      if (rawLineWithNewline[k] === 0x0d) {
        if (
          k + 1 >= rawLineWithNewline.length ||
          rawLineWithNewline[k + 1] !== 0x0a
        ) {
          throw new Error(
            '[SECURITY] Phát hiện ký tự xuống dòng \\r đơn lẻ bất thường trong luồng SQL PostgreSQL!'
          );
        }
      }
    }

    // 3. Ở trạng thái NORMAL đầu câu lệnh: lọc dòng `\restrict`/`\unrestrict` của pg_dump và COMMENT ON EXTENSION
    if (state === 'NORMAL' && stmtPreview.trim().length === 0) {
      const asciiTrimmed = rawLineWithNewline.toString('latin1').trim();
      if (stripRestrict && PG_RESTRICT_LINE_RE.test(asciiTrimmed)) {
        return;
      }
      if (
        options.nonSuperuserRole &&
        SINGLE_LINE_COMMENT_ON_EXTENSION_RE.test(asciiTrimmed)
      ) {
        return;
      }
    }

    const len = rawLineWithNewline.length;
    let i = 0;
    let enteredCopyOnThisLine = false;

    while (i < len) {
      const b = rawLineWithNewline[i];
      const next = i + 1 < len ? rawLineWithNewline[i + 1] : -1;

      if (state === 'LINE_COMMENT') {
        if (b === 0x0a || b === 0x0d) {
          state = 'NORMAL';
          appendStmtPreview('\n');
          appendRawStmtChar('\n');
          resetIdentTracking();
        }
        i++;
        continue;
      }

      if (state === 'BLOCK_COMMENT') {
        if (b === 0x2f && next === 0x2a) {
          blockCommentDepth++;
          i += 2;
          continue;
        }
        if (b === 0x2a && next === 0x2f) {
          blockCommentDepth--;
          if (blockCommentDepth <= 0) {
            blockCommentDepth = 0;
            state = 'NORMAL';
            appendStmtPreview(' ');
            appendRawStmtChar(' ');
            resetIdentTracking();
          }
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (state === 'SINGLE_QUOTE') {
        appendRawStmtChar(String.fromCharCode(b));
        if (singleQuoteEscapeMode && b === 0x5c) {
          if (next !== -1) {
            appendRawStmtChar(String.fromCharCode(next));
          }
          i += 2;
          continue;
        }
        if (b === 0x27) {
          if (next === 0x27) {
            appendRawStmtChar("'");
            i += 2;
            continue;
          }
          state = 'NORMAL';
          singleQuoteEscapeMode = false;
          appendStmtPreview("'s'");
          resetIdentTracking();
          i++;
          continue;
        }
        i++;
        continue;
      }

      if (state === 'DOUBLE_QUOTE') {
        appendRawStmtChar(String.fromCharCode(b));
        if (b === 0x22) {
          if (next === 0x22) {
            appendRawStmtChar('"');
            i += 2;
            continue;
          }
          state = 'NORMAL';
          // S12 Fix: Không chép nội dung bên trong quoted identifier vào stmtPreview để chống giả mạo "COPY x FROM stdin"
          appendStmtPreview('"ident"');
          resetIdentTracking();
          i++;
          continue;
        }
        i++;
        continue;
      }

      if (state === 'DOLLAR_QUOTE') {
        if (b === 0x24) {
          const tagLen = dollarTag.length;
          if (i + tagLen <= len) {
            const candidate = rawLineWithNewline
              .subarray(i, i + tagLen)
              .toString('latin1');
            if (candidate === dollarTag) {
              state = 'NORMAL';
              dollarTag = '';
              appendStmtPreview('$$body$$');
              appendRawStmtChar('$$body$$');
              resetIdentTracking();
              i += tagLen;
              continue;
            }
          }
        }
        i++;
        continue;
      }

      // Trạng thái NORMAL (bên ngoài chuỗi, comment, dollar-quote và COPY)
      if (b === 0x5c) {
        throw new Error(
          '[SECURITY] Phát hiện meta-command psql bị cấm (\\...) trong luồng SQL! Hệ thống đã tự động hủy tiến trình khôi phục để chặn thực thi lệnh hệ thống.'
        );
      }

      if (b === 0x60) {
        throw new Error(
          '[SECURITY] Phát hiện ký tự backtick (`) bất thường bên ngoài chuỗi dữ liệu trong luồng PostgreSQL!'
        );
      }

      if (b === 0x2d && next === 0x2d) {
        state = 'LINE_COMMENT';
        resetIdentTracking();
        i += 2;
        continue;
      }

      if (b === 0x2f && next === 0x2a) {
        state = 'BLOCK_COMMENT';
        blockCommentDepth = 1;
        resetIdentTracking();
        i += 2;
        continue;
      }

      if (b === 0x27) {
        // S12 Fix: Chuỗi escape E'...' chỉ hợp lệ khi đứng trước là token định danh đơn 1 ký tự 'E'/'e' (không thuộc a$E)
        const isEscapeLiteral =
          inIdentToken &&
          identTokenLen === 1 &&
          (lastIdentSingleByte === 0x45 || lastIdentSingleByte === 0x65);
        state = 'SINGLE_QUOTE';
        singleQuoteEscapeMode = isEscapeLiteral;
        appendRawStmtChar("'");
        resetIdentTracking();
        i++;
        continue;
      }

      if (b === 0x22) {
        state = 'DOUBLE_QUOTE';
        appendRawStmtChar('"');
        resetIdentTracking();
        i++;
        continue;
      }

      if (b === 0x24 && !inIdentToken && !prevByteWasDigit) {
        const restAscii = rawLineWithNewline.subarray(i).toString('latin1');
        const m = restAscii.match(
          /^\$(?:[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)?\$/
        );
        if (m) {
          state = 'DOLLAR_QUOTE';
          dollarTag = m[0];
          appendRawStmtChar(dollarTag);
          resetIdentTracking();
          i += dollarTag.length;
          continue;
        }
      }

      const ch = String.fromCharCode(b);
      appendStmtPreview(ch);
      appendRawStmtChar(ch);

      if (inIdentToken) {
        if (isIdentCont(b)) {
          identTokenLen++;
          lastIdentSingleByte = -1;
        } else {
          inIdentToken = false;
          identTokenLen = 0;
          lastIdentSingleByte = -1;
          prevByteWasDigit = isAsciiDigit(b);
        }
      } else if (isIdentStart(b) && !prevByteWasDigit) {
        inIdentToken = true;
        identTokenLen = 1;
        lastIdentSingleByte = b;
        prevByteWasDigit = false;
      } else {
        prevByteWasDigit = isAsciiDigit(b);
      }

      if (b === 0x3b) {
        assertStatementSafe(stmtPreview, rawStmtText);
        if (COPY_FROM_STDIN_RE.test(stmtPreview)) {
          enteredCopyOnThisLine = true;
        }
        stmtPreview = '';
        rawStmtText = '';
        resetIdentTracking();
      }

      i++;
    }

    if (stmtPreview.length >= 256 || rawStmtText.length >= 256) {
      assertStatementSafe(stmtPreview, rawStmtText);
    }

    pushFn(rawLineWithNewline);

    if (enteredCopyOnThisLine) {
      state = 'COPY_DATA';
      copyLineOverflowing = false;
    }
  };

  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: TransformCallback
    ) {
      try {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const combined =
          leftover.length > 0 ? Buffer.concat([leftover, incoming]) : incoming;

        let start = 0;
        for (let idx = 0; idx < combined.length; idx++) {
          if (combined[idx] === 0x0a) {
            const lineSlice = combined.subarray(start, idx + 1);
            processLine(lineSlice, (out) => this.push(out));
            start = idx + 1;
          }
        }

        leftover =
          start < combined.length
            ? Buffer.from(combined.subarray(start))
            : Buffer.alloc(0);

        // N29 Fix: Khi đang trong khối dữ liệu COPY_DATA, các dòng dữ liệu lớn (VD bytea > 64 MiB) không chứa '\n'
        // chắc chắn không phải dòng kết thúc `\.` (dài tối đa 4 byte), nên truyền thẳng ra ngoài để không giới hạn kích thước dòng và không tốn RAM.
        if (state === 'COPY_DATA' && leftover.length > 64 * 1024) {
          copyLineOverflowing = true;
          if (options.onBytesTransferred) {
            options.onBytesTransferred(leftover.length);
          }
          this.push(leftover);
          leftover = Buffer.alloc(0);
        } else if (state !== 'COPY_DATA' && leftover.length > 64 * 1024 * 1024) {
          throw new Error(
            '[SECURITY] Dòng lệnh SQL đơn lẻ vượt quá giới hạn an toàn 64 MiB.'
          );
        }

        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        if (leftover.length > 0) {
          processLine(leftover, (out) => this.push(out));
          leftover = Buffer.alloc(0);
        }
        if (stmtPreview.trim().length > 0 || rawStmtText.trim().length > 0) {
          assertStatementSafe(stmtPreview, rawStmtText);
          stmtPreview = '';
          rawStmtText = '';
        }
        if (state === 'COPY_DATA') {
          throw new Error(
            'Luồng PostgreSQL kết thúc đột ngột khi khối dữ liệu COPY ... FROM stdin chưa đóng bằng \\.'
          );
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

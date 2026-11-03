import { Transform, type TransformCallback } from 'node:stream';

export interface SafePsqlStreamOptions {
  /**
   * Nếu truyền tên Role đích (không phải superuser), tự động bỏ qua câu lệnh
   * `COMMENT ON EXTENSION ...;` vốn chỉ superuser chủ sở hữu extension mới chạy được.
   */
  nonSuperuserRole?: string;
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

const PG_RESTRICT_LINE_RE = /^\\(?:un)?restrict\s+[A-Za-z0-9]{16,128}$/;

const FORBIDDEN_PG_STMT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\bCOPY\b[\s\S]*?\b(?:TO|FROM)\s+PROGRAM\b/i,
    reason:
      '[SECURITY] Phát hiện câu lệnh COPY ... PROGRAM nguy hiểm trong bản sao lưu PostgreSQL!',
  },
  {
    re: /\bSET\s+(?:SESSION\s+|LOCAL\s+)?STANDARD_CONFORMING_STRINGS\s*(?:=|TO)\s*(?:OFF|FALSE|0|'OFF'|'FALSE'|'0')\b/i,
    reason:
      '[SECURITY] Không cho phép tắt standard_conforming_strings trong luồng khôi phục PostgreSQL!',
  },
  {
    re: /\b(?:SET\s+(?:SESSION\s+|LOCAL\s+)?ROLE|RESET\s+ROLE|SET\s+(?:SESSION\s+|LOCAL\s+)?SESSION\s+AUTHORIZATION|RESET\s+SESSION\s+AUTHORIZATION)\b/i,
    reason:
      '[SECURITY] Chặn thao tác thay đổi đặc quyền phiên (ROLE / SESSION AUTHORIZATION) từ bên trong tệp dump SQL!',
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

function isIdentChar(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x5f || // _
    byte >= 0x80
  );
}

/**
 * Bộ lọc luồng SQL an toàn cho `psql` (Phòng vệ chiều sâu cho `S1` & `S6`):
 * - Phân tích từ vựng luồng byte SQL chính xác theo quy tắc của PostgreSQL (`'...'`, `E'...'`, `"..."`, `$tag$...$tag$`,
 *   comment lồng `/* ... * /`, `-- ...`, và khối dữ liệu `COPY ... FROM stdin` ... `\.`).
 * - Chặn đứng 100% mọi meta-command `psql` bắt đầu bằng `\` ở trạng thái lệnh (như `\!`, `\o`, `\i`, `\copy`, `\gexec`, `\setenv`),
 *   kể cả khi đặt giữa dòng sau dấu `;` (`SELECT 1; \! id`) và trên mọi phiên bản `psql` cũ chưa có `\restrict`.
 * - Tự động bóc tách dòng `\restrict` / `\unrestrict` hợp lệ của `pg_dump` mới để không gây lỗi cú pháp trên VPS chạy `psql` cũ.
 * - Chặn `COPY ... PROGRAM`, ngôn ngữ `plperlu`/`plpythonu`/`C`, và lệnh thoát phiên `RESET SESSION AUTHORIZATION` / `SET ROLE`.
 * - Bảo toàn nguyên vẹn 100% từng byte nhị phân/UTF-8 bên trong chuỗi và dữ liệu `COPY`.
 */
export function createSafePsqlRestoreTransform(
  options: SafePsqlStreamOptions = {}
): Transform {
  let state: PsqlLexState = 'NORMAL';
  let singleQuoteEscapeMode = false; // E'...'
  let dollarTag = ''; // Ví dụ "$$" hoặc "$body$"
  let blockCommentDepth = 0;

  let leftover: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stmtPreview = '';
  let prevByteWasIdent = false;

  const MAX_STMT_PREVIEW = 8192;

  const appendStmtPreview = (ch: string) => {
    if (stmtPreview.length < MAX_STMT_PREVIEW) {
      stmtPreview += ch;
    } else {
      // Giữ cả đầu lẫn đuôi câu lệnh dài để không bỏ sót từ khóa ở cuối (VD: LANGUAGE plperlu / FROM stdin)
      stmtPreview =
        stmtPreview.slice(0, 4096) + ' ' + stmtPreview.slice(-3072) + ch;
    }
  };

  const assertStatementSafe = (stmtText: string): void => {
    const trimmed = stmtText.trim();
    if (!trimmed) return;
    for (const rule of FORBIDDEN_PG_STMT_PATTERNS) {
      if (rule.re.test(trimmed)) {
        throw new Error(rule.reason);
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

    // 1. Bên trong khối dữ liệu COPY ... FROM stdin: chỉ kết thúc khi gặp đúng dòng `\.`
    if (state === 'COPY_DATA') {
      let endIdx = rawLineWithNewline.length;
      if (endIdx > 0 && rawLineWithNewline[endIdx - 1] === 0x0a) endIdx--;
      if (endIdx > 0 && rawLineWithNewline[endIdx - 1] === 0x0d) endIdx--;

      if (
        endIdx === 2 &&
        rawLineWithNewline[0] === 0x5c && // '\'
        rawLineWithNewline[1] === 0x2e // '.'
      ) {
        state = 'NORMAL';
        prevByteWasIdent = false;
      }
      pushFn(rawLineWithNewline);
      return;
    }

    // 2. Ở trạng thái NORMAL đầu câu lệnh: lọc dòng `\restrict`/`\unrestrict` của pg_dump mới và COMMENT ON EXTENSION
    if (state === 'NORMAL' && stmtPreview.trim().length === 0) {
      const asciiTrimmed = rawLineWithNewline.toString('latin1').trim();
      if (PG_RESTRICT_LINE_RE.test(asciiTrimmed)) {
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
        if (b === 0x0a) {
          state = 'NORMAL';
          appendStmtPreview('\n');
          prevByteWasIdent = false;
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
            prevByteWasIdent = false;
          }
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      if (state === 'SINGLE_QUOTE') {
        if (singleQuoteEscapeMode && b === 0x5c) {
          i += 2;
          continue;
        }
        if (b === 0x27) {
          if (next === 0x27) {
            i += 2;
            continue;
          }
          state = 'NORMAL';
          singleQuoteEscapeMode = false;
          appendStmtPreview("'s'");
          prevByteWasIdent = false;
          i++;
          continue;
        }
        i++;
        continue;
      }

      if (state === 'DOUBLE_QUOTE') {
        appendStmtPreview(String.fromCharCode(b));
        if (b === 0x22) {
          if (next === 0x22) {
            appendStmtPreview('"');
            i += 2;
            continue;
          }
          state = 'NORMAL';
          prevByteWasIdent = false;
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
              prevByteWasIdent = false;
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
        i += 2;
        continue;
      }

      if (b === 0x2f && next === 0x2a) {
        state = 'BLOCK_COMMENT';
        blockCommentDepth = 1;
        i += 2;
        continue;
      }

      if (b === 0x27) {
        const prevByte = i > 0 ? rawLineWithNewline[i - 1] : -1;
        const prevPrevByte = i > 1 ? rawLineWithNewline[i - 2] : -1;
        const isEscapeLiteral =
          (prevByte === 0x45 || prevByte === 0x65) && // 'E' hoặc 'e'
          (prevPrevByte === -1 || !isIdentChar(prevPrevByte));
        state = 'SINGLE_QUOTE';
        singleQuoteEscapeMode = isEscapeLiteral;
        prevByteWasIdent = false;
        i++;
        continue;
      }

      if (b === 0x22) {
        state = 'DOUBLE_QUOTE';
        appendStmtPreview('"');
        prevByteWasIdent = false;
        i++;
        continue;
      }

      if (b === 0x24 && !prevByteWasIdent) {
        const restAscii = rawLineWithNewline.subarray(i).toString('latin1');
        const m = restAscii.match(
          /^\$(?:[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*)?\$/
        );
        if (m) {
          state = 'DOLLAR_QUOTE';
          dollarTag = m[0];
          prevByteWasIdent = false;
          i += dollarTag.length;
          continue;
        }
      }

      appendStmtPreview(String.fromCharCode(b));
      prevByteWasIdent = isIdentChar(b);

      if (b === 0x3b) {
        assertStatementSafe(stmtPreview);
        if (COPY_FROM_STDIN_RE.test(stmtPreview)) {
          enteredCopyOnThisLine = true;
        }
        stmtPreview = '';
      }

      i++;
    }

    // Kiểm tra định kỳ ngay cả khi kẻ tấn công cố tình không đặt dấu ';'
    if (stmtPreview.length >= 256) {
      assertStatementSafe(stmtPreview);
    }

    pushFn(rawLineWithNewline);

    if (enteredCopyOnThisLine) {
      state = 'COPY_DATA';
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

        if (leftover.length > 64 * 1024 * 1024) {
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
        if (stmtPreview.trim().length > 0) {
          assertStatementSafe(stmtPreview);
          stmtPreview = '';
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

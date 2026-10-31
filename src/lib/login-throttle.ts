/**
 * Giới hạn số lần đăng nhập sai (in-memory) để chống dò mật khẩu.
 * Khóa theo cặp IP + username: kẻ tấn công từ một IP không thể khóa tài khoản admin từ IP khác.
 */
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;

interface FailureRecord {
  count: number;
  firstAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __nasSyncLoginFailures: Map<string, FailureRecord> | undefined;
}

function getStore(): Map<string, FailureRecord> {
  if (!globalThis.__nasSyncLoginFailures) {
    globalThis.__nasSyncLoginFailures = new Map();
  }
  return globalThis.__nasSyncLoginFailures;
}

function prune(store: Map<string, FailureRecord>, now: number) {
  for (const [key, rec] of store) {
    if (now - rec.firstAt > WINDOW_MS) store.delete(key);
  }
}

/** Trả về số giây cần chờ nếu đang bị khóa, hoặc 0 nếu được phép thử. */
export function getLoginLockSeconds(key: string): number {
  const store = getStore();
  const now = Date.now();
  prune(store, now);
  const rec = store.get(key);
  if (!rec || rec.count < MAX_FAILURES) return 0;
  return Math.ceil((rec.firstAt + WINDOW_MS - now) / 1000);
}

export function recordLoginFailure(key: string) {
  const store = getStore();
  const rec = store.get(key);
  if (rec) {
    rec.count += 1;
  } else {
    store.set(key, { count: 1, firstAt: Date.now() });
  }
}

export function clearLoginFailures(key: string) {
  getStore().delete(key);
}

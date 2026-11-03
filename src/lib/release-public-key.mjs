/**
 * U16 & U9 Security Fix:
 * Nguồn chân lý duy nhất (Single Source of Truth) cho khóa công khai Ed25519 xác thực gói phát hành NAS-Sync
 * và chuỗi phân tách miền chữ ký (Domain Separation) cho cả gói Prebuilt (1-Click UI) lẫn gói Bundle (CLI update.sh).
 */
export const DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApSztKo5UUyVAV5hfAmATSIyCR6Teo3PDUEkE4HXi30Q=
-----END PUBLIC KEY-----`;

export const PREBUILT_SIGNATURE_DOMAIN = 'nas-sync-release-v1';
export const BUNDLE_SIGNATURE_DOMAIN = 'nas-sync-bundle-v1';

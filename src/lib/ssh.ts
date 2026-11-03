import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostKeyStatus, ServerRecord } from '@/types';
import { getDataDir, getDb, getSshKeysDir } from './db';
import { isSafeHostAddress } from './engine/safe-names';
import { createSystemAlert } from './notifications';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const MOCK_HOST_KEY_FINGERPRINT =
  'SHA256:MockEd25519HostKeyPinningDemoV140';

/**
 * Bọc câu lệnh trên VPS bằng ionice và nice để đảm bảo Zero-Impact Backup (Mục 5.1)
 * Nếu hệ điều hành VPS container (OpenVZ/LXC) không có ionice thì tự động fallback sang nice -n 19.
 */
export function wrapZeroImpact(remoteCommand: string): string {
  const quoted = shellSingleQuote(remoteCommand);
  return `if command -v ionice >/dev/null 2>&1 && command -v nice >/dev/null 2>&1 && ionice -c 2 -n 7 true 2>/dev/null; then ionice -c 2 -n 7 nice -n 19 sh -c ${quoted}; elif command -v nice >/dev/null 2>&1; then nice -n 19 sh -c ${quoted}; else sh -c ${quoted}; fi`;
}

export function shellSingleQuote(str: string): string {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

const SAFE_SSH_KEY_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const OPENSSH_KEY_TYPE_RE = /^(?:ssh-|ecdsa-sha2-|sk-)[A-Za-z0-9@._-]+$/;
const BASE64_BLOB_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const RESERVED_OPENSSH_CONTROL_FILES = new Set([
  'config',
  'authorized_keys',
  'authorized_keys2',
  'known_hosts',
  'known_hosts.old',
  'rc',
  'environment',
]);

export interface ParsedOpenSshKeyLine {
  hostToken: string;
  keyType: string;
  keyBase64: string;
  rawLine: string;
}

function parseSingleOpenSshKeyLine(line: string): ParsedOpenSshKeyLine | null {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#') || /[\0\r\n]/.test(trimmed)) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  let hostToken = '';
  let keyType: string;
  let keyBase64: string;

  if (tokens.length >= 2 && OPENSSH_KEY_TYPE_RE.test(tokens[0])) {
    keyType = tokens[0];
    keyBase64 = tokens[1];
  } else if (tokens.length >= 3 && OPENSSH_KEY_TYPE_RE.test(tokens[1])) {
    hostToken = tokens[0];
    keyType = tokens[1];
    keyBase64 = tokens[2];
  } else {
    return null;
  }

  if (!BASE64_BLOB_RE.test(keyBase64) || keyBase64.length < 24) {
    return null;
  }

  const decoded = Buffer.from(keyBase64, 'base64');
  if (
    decoded.length < 16 ||
    decoded.toString('base64').replace(/=+$/, '') !==
      keyBase64.replace(/=+$/, '')
  ) {
    return null;
  }

  const normalizedLine = hostToken
    ? `${hostToken} ${keyType} ${keyBase64}`
    : `${keyType} ${keyBase64}`;

  return {
    hostToken,
    keyType,
    keyBase64,
    rawLine: normalizedLine,
  };
}

/**
 * Tính dấu vân tay OpenSSH chuẩn RFC 4253 (`SHA256:<unpadded-base64> (<KEYTYPE>)`)
 * trực tiếp bằng `node:crypto` không phụ thuộc tiến trình ngoài.
 */
export function computeOpenSshKeyFingerprint(knownHostLine: string): string {
  const parsed = parseSingleOpenSshKeyLine(knownHostLine);
  if (!parsed) {
    throw new Error('Dòng khóa định danh OpenSSH không hợp lệ.');
  }

  const rawKeyBytes = Buffer.from(parsed.keyBase64, 'base64');
  const digest = crypto
    .createHash('sha256')
    .update(rawKeyBytes)
    .digest('base64')
    .replace(/=+$/, '');

  return `SHA256:${digest} (${parsed.keyType.toUpperCase()})`;
}

function parseKnownHostsBlock(rawBlock: string): ParsedOpenSshKeyLine[] {
  if (!rawBlock) return [];
  const entries: ParsedOpenSshKeyLine[] = [];
  const seen = new Set<string>();

  for (const line of String(rawBlock).split(/\r?\n/)) {
    const parsed = parseSingleOpenSshKeyLine(line);
    if (!parsed || !parsed.hostToken) continue;
    const dedupKey = `${parsed.hostToken}|${parsed.keyType}|${parsed.keyBase64}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      entries.push(parsed);
    }
  }
  return entries;
}

function selectPrimaryHostKeyEntry(
  entries: ParsedOpenSshKeyLine[]
): ParsedOpenSshKeyLine {
  return (
    entries.find((e) => e.keyType === 'ssh-ed25519') ||
    entries.find((e) => e.keyType === 'ecdsa-sha2-nistp256') ||
    entries.find((e) => e.keyType.startsWith('ecdsa-sha2-')) ||
    entries.find((e) => e.keyType === 'ssh-rsa') ||
    entries[0]
  );
}

export function getKnownHostsDir(): string {
  const dir = path.join(getDataDir(), 'known_hosts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Bỏ qua trên mount chỉ đọc hoặc có NFSv4 / RichACL trên NAS
    }
  }
  return dir;
}

function getSshMuxDir(): string | null {
  if (process.platform === 'win32') {
    return null;
  }
  const dir = path.join(getDataDir(), '.ssh_mux');
  try {
    const existingStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (existingStat) {
      if (existingStat.isSymbolicLink() || !existingStat.isDirectory()) {
        return null;
      }
    } else {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Bỏ qua trên mount có RichACL
    }
    const verifiedStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (
      !verifiedStat ||
      verifiedStat.isSymbolicLink() ||
      !verifiedStat.isDirectory()
    ) {
      return null;
    }
    if (typeof process.getuid === 'function') {
      const currentUid = process.getuid();
      if (verifiedStat.uid !== currentUid || (verifiedStat.mode & 0o077) !== 0) {
        return null;
      }
    }
    return dir;
  } catch {
    return null;
  }
}

const PERMANENT_SSH_ERROR_RE =
  /Permission denied|REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|\[SECURITY\]|Bad configuration option|Identity file .* not accessible/i;

const TRANSIENT_SSH_TRANSPORT_RE =
  /kex_exchange_identification|Connection reset by peer|Connection reset by |Connection closed by |Connection timed out|Operation timed out|Banner exchange|Broken pipe|No route to host|Temporary failure in name resolution|Network is unreachable|Connection refused|mux_client_request_session/i;

export function isTransientSshTransportError(
  code: number,
  stderrOrMessage: string
): boolean {
  const text = String(stderrOrMessage || '');
  if (PERMANENT_SSH_ERROR_RE.test(text)) {
    return false;
  }
  if (TRANSIENT_SSH_TRANSPORT_RE.test(text)) {
    return true;
  }
  return code === 255 && text.trim().length > 0;
}

export function getSshControlMuxPath(disableMux?: boolean): string | null {
  if (disableMux || process.platform === 'win32') {
    return null;
  }
  const muxDir = getSshMuxDir();
  if (!muxDir) {
    return null;
  }
  // OpenSSH %C mở rộng thành 40 ký tự hex; giới hạn UNIX domain socket sun_path ~ 104 bytes
  if (Buffer.byteLength(muxDir, 'utf8') + 1 + 40 >= 100) {
    return null;
  }
  return `${muxDir}/%C`;
}

export function removeServerKnownHostsCache(serverId: number): void {
  if (!Number.isInteger(serverId) || serverId <= 0) return;
  const fileName = `server_${serverId}.known_hosts`;
  const candidates = [
    path.join(getKnownHostsDir(), fileName),
    path.join(os.tmpdir(), '.nas_sync_known_hosts', fileName),
  ];
  for (const filePath of candidates) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  if (process.platform !== 'win32') {
    try {
      const muxDir = getSshMuxDir();
      if (muxDir) {
        for (const entry of fs.readdirSync(muxDir)) {
          fs.rmSync(path.join(muxDir, entry), { force: true });
        }
      }
    } catch {
      // Ignore mux socket cleanup errors
    }
  }
}

export function materializeServerKnownHostsFile(
  server: ServerRecord
): string | null {
  if (server.host_key_status === 'MISMATCH') {
    return null;
  }
  let entry = (server.known_host_entry || '').trim();
  if (!entry && Number(server.id) > 0) {
    try {
      const fresh = getDb()
        .prepare(
          'SELECT host_key_status, known_host_entry FROM servers WHERE id = ?'
        )
        .get(server.id) as
        | { host_key_status?: string; known_host_entry?: string }
        | undefined;
      if (fresh?.host_key_status === 'MISMATCH') {
        return null;
      }
      entry = (fresh?.known_host_entry || '').trim();
    } catch {
      // Ignore DB lookup fallback errors
    }
  }
  if (!entry) {
    return null;
  }

  const validEntries = parseKnownHostsBlock(entry);
  if (validEntries.length === 0) {
    return null;
  }

  const content = `${validEntries.map((e) => e.rawLine).join('\n')}\n`;
  const fileName = `server_${Number(server.id || 0)}.known_hosts`;
  const primaryPath = path.join(getKnownHostsDir(), fileName);

  try {
    const existing = fs.existsSync(primaryPath)
      ? fs.readFileSync(primaryPath, 'utf8')
      : null;
    if (existing !== content) {
      fs.writeFileSync(primaryPath, content, { encoding: 'utf8', mode: 0o600 });
    }
  } catch {
    // Nếu không ghi được vào DATA_DIR, fallback thẳng sang tmpdir bên dưới
  }

  if (process.platform === 'win32' && fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  if (process.platform !== 'win32' && fs.existsSync(primaryPath)) {
    try {
      fs.chmodSync(primaryPath, 0o600);
    } catch {
      // Ignore RichACL warning
    }
    try {
      const stat = fs.statSync(primaryPath);
      const currentUid =
        typeof process.getuid === 'function' ? process.getuid() : 0;
      if ((stat.mode & 0o077) === 0 && stat.uid === currentUid) {
        return primaryPath;
      }
    } catch {
      // Fallback sang tmpfs
    }
  }

  // Nếu thư mục bind-mount trên NAS dính Windows/SMB ACL (0777 hoặc UID khác),
  // tạo bản sao chuẩn quyền 0600 trong tmpfs nội bộ container
  const safeTmpDir = path.join(os.tmpdir(), '.nas_sync_known_hosts');
  fs.mkdirSync(safeTmpDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(safeTmpDir, 0o700);
    } catch {
      // Ignore
    }
  }
  const stagedPath = path.join(safeTmpDir, fileName);
  fs.writeFileSync(stagedPath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(stagedPath, 0o600);
    } catch {
      // Ignore
    }
  }
  return stagedPath;
}

function assertNotHostKeyMismatch(server: ServerRecord): void {
  if (server.host_key_status === 'MISMATCH') {
    throw new Error(
      `[SECURITY] Máy chủ "${server.hostname}" đang bị khóa kết nối do phát hiện thay đổi SSH Host Key bất thường! Quản trị viên (ADMIN) cần kiểm tra và xác nhận trên trang Máy chủ VPS.`
    );
  }
}

/**
 * Cơ chế TOFU (Trust-On-First-Use) & Khóa chống tấn công MITM cho SSH Host Key:
 * - Lần kết nối đầu tiên (`UNPINNED`): quét khóa định danh và ghim cố định vào SQLite (`VERIFIED`).
 * - Các lần sau: đối chiếu toàn bộ dòng khóa OpenSSH; nếu khóa thay đổi bất thường sẽ chuyển sang `MISMATCH`,
 *   khóa kết nối ngay lập tức và phát cảnh báo an ninh CRITICAL.
 */
export async function ensureServerHostKeyPinned(
  serverId: number,
  injectedScanStdout?: string,
  options?: { forceRescan?: boolean }
): Promise<{ status: HostKeyStatus; fingerprint: string; changed?: boolean }> {
  const db = getDb();
  const server = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(serverId) as unknown as ServerRecord | undefined;

  if (!server) {
    throw new Error(`Không tìm thấy máy chủ ID=${serverId}`);
  }

  if (server.is_mock) {
    const fp = server.host_key_fingerprint || MOCK_HOST_KEY_FINGERPRINT;
    if (server.host_key_status !== 'VERIFIED' || !server.host_key_fingerprint) {
      db.prepare(
        `UPDATE servers
         SET host_key_status = 'VERIFIED',
             host_key_fingerprint = ?,
             host_key_pending_fingerprint = '',
             host_key_pending_entry = ''
         WHERE id = ?`
      ).run(fp, server.id);
    }
    return { status: 'VERIFIED', fingerprint: fp, changed: false };
  }

  const ipAddr = (server.ip_address || '').trim();
  const port = Number(server.ssh_port || 22);
  if (!isSafeHostAddress(ipAddr)) {
    throw new Error('Địa chỉ IP / Hostname của máy chủ không hợp lệ.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Cổng SSH không hợp lệ: ${server.ssh_port}`);
  }

  // Khi khóa đã được ghim VERIFIED, không gọi lại `ssh-keyscan` (mở 5 kết nối TCP chưa xác thực cùng lúc
  // dễ kích hoạt CSF PORTFLOOD / PerSourceMaxStartups gây lỗi `kex_exchange_identification: Connection reset by peer`).
  // OpenSSH đã kiểm tra trực tiếp khóa ghim qua `StrictHostKeyChecking=yes` + `UserKnownHostsFile`.
  const preExistingEntries = parseKnownHostsBlock(
    server.known_host_entry || ''
  );
  if (
    injectedScanStdout === undefined &&
    !options?.forceRescan &&
    server.host_key_status === 'VERIFIED' &&
    preExistingEntries.length > 0
  ) {
    const fp =
      server.host_key_fingerprint ||
      computeOpenSshKeyFingerprint(
        selectPrimaryHostKeyEntry(preExistingEntries).rawLine
      );
    return { status: 'VERIFIED', fingerprint: fp, changed: false };
  }

  let scanStdout: string;
  let scanStderr = '';
  if (injectedScanStdout !== undefined) {
    scanStdout = injectedScanStdout;
  } else {
    const scanRes = await execLocalCommand(
      'ssh-keyscan',
      ['-T', '10', '-t', 'ed25519,ecdsa,rsa', '-p', String(port), ipAddr],
      15000
    );
    scanStdout = scanRes.stdout;
    scanStderr = scanRes.stderr;
  }

  const scannedEntries = parseKnownHostsBlock(scanStdout);
  if (scannedEntries.length === 0) {
    assertNotHostKeyMismatch(server);
    const detail = scanStderr
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .join(' ')
      .trim();
    throw new Error(
      `Không thể thu thập SSH Host Key từ ${ipAddr}:${port}${
        detail ? ` (${detail})` : ' — Vui lòng kiểm tra kết nối mạng hoặc cổng SSH'
      }.`
    );
  }

  const primaryScanned = selectPrimaryHostKeyEntry(scannedEntries);
  const scannedFingerprint = computeOpenSshKeyFingerprint(
    primaryScanned.rawLine
  );
  const normalizedScannedBlock = scannedEntries.map((e) => e.rawLine).join('\n');

  const storedRaw = (server.known_host_entry || '').trim();
  if (!storedRaw || server.host_key_status === 'UNPINNED') {
    db.prepare(
      `UPDATE servers
       SET known_host_entry = ?,
           host_key_fingerprint = ?,
           host_key_status = 'VERIFIED',
           host_key_pending_fingerprint = '',
           host_key_pending_entry = ''
       WHERE id = ?`
    ).run(normalizedScannedBlock, scannedFingerprint, server.id);
    removeServerKnownHostsCache(server.id);
    return {
      status: 'VERIFIED',
      fingerprint: scannedFingerprint,
      changed: false,
    };
  }

  const storedEntries = parseKnownHostsBlock(storedRaw);
  const storedKeyIdentities = new Set(
    storedEntries.map((e) => `${e.keyType} ${e.keyBase64}`)
  );
  const isSubsetOfPinned =
    storedEntries.length > 0 &&
    scannedEntries.every((s) =>
      storedKeyIdentities.has(`${s.keyType} ${s.keyBase64}`)
    );

  if (isSubsetOfPinned) {
    const effectiveFp = server.host_key_fingerprint || scannedFingerprint;
    if (
      server.host_key_status !== 'VERIFIED' ||
      server.host_key_fingerprint !== effectiveFp ||
      server.host_key_pending_entry ||
      server.host_key_pending_fingerprint
    ) {
      db.prepare(
        `UPDATE servers
         SET host_key_fingerprint = ?,
             host_key_status = 'VERIFIED',
             host_key_pending_fingerprint = '',
             host_key_pending_entry = ''
         WHERE id = ?`
      ).run(effectiveFp, server.id);
      removeServerKnownHostsCache(server.id);
    }
    return {
      status: 'VERIFIED',
      fingerprint: effectiveFp,
      changed: false,
    };
  }

  // PHÁT HIỆN THAY ĐỔI HOST KEY BẤT THƯỜNG HOẶC CHÈN THÊM KHÓA LẠ (NGUY CƠ MITM HOẶC CÀI LẠI OS VPS)!
  const mismatchedEntry = scannedEntries.find(
    (s) => !storedKeyIdentities.has(`${s.keyType} ${s.keyBase64}`)
  );
  const mismatchFingerprint = mismatchedEntry
    ? computeOpenSshKeyFingerprint(mismatchedEntry.rawLine)
    : scannedFingerprint;

  const alreadyAlertedSameKey =
    server.host_key_status === 'MISMATCH' &&
    server.host_key_pending_fingerprint === mismatchFingerprint;

  db.prepare(
    `UPDATE servers
     SET host_key_status = 'MISMATCH',
         host_key_pending_fingerprint = ?,
         host_key_pending_entry = ?,
         status = 'ERROR'
     WHERE id = ?`
  ).run(mismatchFingerprint, normalizedScannedBlock, server.id);
  removeServerKnownHostsCache(server.id);

  if (!alreadyAlertedSameKey) {
    await createSystemAlert({
      severity: 'CRITICAL',
      category: 'SYSTEM',
      serverId: server.id,
      title: `CẢNH BÁO AN NINH: Thay đổi SSH Host Key trên ${server.hostname}`,
      message: `Phát hiện khóa định danh SSH của VPS ${server.hostname} (${server.ip_address}:${server.ssh_port}) đã thay đổi hoặc xuất hiện khóa lạ [${mismatchFingerprint}] (trước đó: [${server.host_key_fingerprint}])! Hệ thống đã tự động khóa mọi kết nối Sao lưu/Khôi phục để phòng chống tấn công MITM.`,
    });
  }

  throw new Error(
    `[SECURITY] Phát hiện SSH Host Key của máy chủ "${server.hostname}" (${ipAddr}:${port}) đã thay đổi hoặc xuất hiện khóa lạ [${mismatchFingerprint}] (trước đó: [${server.host_key_fingerprint}])! Hệ thống đã tự động khóa kết nối để chống tấn công MITM — Quản trị viên (ADMIN) cần kiểm tra và xác nhận trên trang Máy chủ VPS.`
  );
}

export function validateSafeSshKeyName(rawName: string): string {
  const trimmed = String(rawName || '').trim();
  if (!trimmed) {
    throw new Error('Tên khóa SSH không được để trống.');
  }
  if (
    trimmed.startsWith('.') ||
    trimmed.startsWith('-') ||
    trimmed.includes('..') ||
    !SAFE_SSH_KEY_NAME_RE.test(trimmed)
  ) {
    throw new Error(
      'Tên khóa SSH không hợp lệ (chỉ cho phép chữ, số, ".", "_", "-", dài 1–64 ký tự và không bắt đầu bằng "." hay "-").'
    );
  }

  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.pub')) {
    throw new Error('Tên định danh khóa SSH không được kết thúc bằng ".pub".');
  }
  const lowerWithoutPub = lower.endsWith('.pub') ? lower.slice(0, -4) : lower;
  if (
    RESERVED_OPENSSH_CONTROL_FILES.has(lower) ||
    RESERVED_OPENSSH_CONTROL_FILES.has(lowerWithoutPub)
  ) {
    throw new Error(
      `Tên khóa SSH "${trimmed}" trùng với tệp điều khiển hệ thống OpenSSH bị cấm (${Array.from(
        RESERVED_OPENSSH_CONTROL_FILES
      ).join(', ')}).`
    );
  }

  return trimmed;
}

export function resolveValidatedSshKeyPath(sshKeyPath: string): string {
  const raw = String(sshKeyPath || '').trim();
  if (!raw) {
    throw new Error('Đường dẫn khóa SSH không được để trống.');
  }
  if (raw.includes('\0')) {
    throw new Error('Đường dẫn khóa SSH chứa ký tự không hợp lệ.');
  }

  const keysDir = path.resolve(getSshKeysDir());
  const resolved = path.resolve(raw);
  const parentDir = path.dirname(resolved);

  const sameDir =
    process.platform === 'win32'
      ? parentDir.toLowerCase() === keysDir.toLowerCase()
      : parentDir === keysDir;

  if (!sameDir) {
    throw new Error(
      'Đường dẫn khóa SSH phải nằm trực tiếp bên trong thư mục quản lý khóa SSH được cấp phép.'
    );
  }

  const baseName = path.basename(resolved);
  validateSafeSshKeyName(baseName);

  const lstat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (lstat && !lstat.isFile()) {
    throw new Error(
      'Tệp khóa SSH không hợp lệ (không chấp nhận thư mục, symlink hoặc thiết bị đặc biệt).'
    );
  }

  return resolved;
}

function resolveServerKeyPath(server: ServerRecord): string | null {
  let candidate = (server.ssh_key_path || '').trim();
  if (candidate) {
    candidate = resolveValidatedSshKeyPath(candidate);
  } else {
    try {
      const latestKey = getDb()
        .prepare(
          'SELECT private_key_path FROM ssh_keys ORDER BY id DESC LIMIT 1'
        )
        .get() as { private_key_path?: string } | undefined;
      if (latestKey?.private_key_path) {
        candidate = resolveValidatedSshKeyPath(latestKey.private_key_path.trim());
      }
    } catch {
      // Bỏ qua nếu CSDL chưa khởi tạo hoặc đường dẫn cũ không hợp lệ
      candidate = '';
    }
  }

  if (!candidate || !fs.existsSync(candidate)) {
    return null;
  }

  const keyStat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!keyStat || !keyStat.isFile()) {
    return null;
  }

  if (process.platform === 'win32') {
    return candidate;
  }

  try {
    fs.chmodSync(candidate, 0o600);
  } catch {
    // Bỏ qua trên mount chỉ đọc hoặc có NFSv4 / RichACL trên NAS
  }

  try {
    const stat = fs.statSync(candidate);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    if ((stat.mode & 0o077) === 0 && stat.uid === currentUid) {
      return candidate;
    }

    // Nếu thư mục bind-mount trên NAS dính Windows/SMB ACL (0777 hoặc UID host),
    // sao chép sang tmpfs nội bộ container với chuẩn quyền 0600 để OpenSSH không từ chối key
    const safeDir = path.join(os.tmpdir(), '.nas_sync_ssh_keys');
    fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(safeDir, 0o700);
    const stagedPath = path.join(safeDir, path.basename(candidate));
    fs.copyFileSync(candidate, stagedPath);
    fs.chmodSync(stagedPath, 0o600);
    return stagedPath;
  } catch {
    return candidate;
  }
}

export function buildSshBaseArgs(
  server: ServerRecord,
  options: { disableMux?: boolean } = {}
): string[] {
  assertNotHostKeyMismatch(server);

  const port = Number(server.ssh_port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Cổng SSH không hợp lệ: ${server.ssh_port}`);
  }

  const knownHostsFile = materializeServerKnownHostsFile(server);
  if (!knownHostsFile) {
    throw new Error(
      `[SECURITY] Máy chủ "${server.hostname}" chưa có khóa định danh SSH Host Key được ghim (known_hosts). Hệ thống từ chối kết nối chưa xác thực (fail-closed) — vui lòng xác thực TOFU trước.`
    );
  }
  const muxPath = getSshControlMuxPath(options.disableMux);

  const args: string[] = [
    '-F',
    '/dev/null',
    '-p',
    String(port),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    'IgnoreUnknown=WarnWeakCrypto,ControlMaster,ControlPath,ControlPersist',
    '-o',
    'WarnWeakCrypto=no',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ConnectionAttempts=3',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];

  if (muxPath) {
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${muxPath}`,
      '-o',
      'ControlPersist=90'
    );
  }

  const resolvedKey = resolveServerKeyPath(server);
  if (resolvedKey) {
    args.push('-i', resolvedKey);
  }

  return args;
}

export function buildRsyncSshTransport(
  server: ServerRecord,
  options: { disableMux?: boolean } = {}
): string {
  assertNotHostKeyMismatch(server);

  const port = Number(server.ssh_port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Cổng SSH không hợp lệ: ${server.ssh_port}`);
  }

  const resolvedKey = resolveServerKeyPath(server);
  const knownHostsFile = materializeServerKnownHostsFile(server);
  if (!knownHostsFile) {
    throw new Error(
      `[SECURITY] Máy chủ "${server.hostname}" chưa có khóa định danh SSH Host Key được ghim (known_hosts). Hệ thống từ chối kết nối Rsync chưa xác thực (fail-closed) — vui lòng xác thực TOFU trước.`
    );
  }
  const muxPath = getSshControlMuxPath(options.disableMux);

  const parts: string[] = ['ssh', '-F /dev/null'];
  if (resolvedKey) {
    parts.push(`-i ${shellSingleQuote(resolvedKey)}`);
  }
  parts.push(
    `-p ${port}`,
    '-o BatchMode=yes',
    '-o StrictHostKeyChecking=yes',
    `-o UserKnownHostsFile=${shellSingleQuote(knownHostsFile)}`,
    '-o IgnoreUnknown=WarnWeakCrypto,ControlMaster,ControlPath,ControlPersist',
    '-o WarnWeakCrypto=no',
    '-o ConnectTimeout=15',
    '-o ConnectionAttempts=3',
    '-o ServerAliveInterval=15',
    '-o ServerAliveCountMax=3',
    '-o Compression=no'
  );

  if (muxPath) {
    parts.push(
      '-o ControlMaster=auto',
      `-o ControlPath=${shellSingleQuote(muxPath)}`,
      '-o ControlPersist=90'
    );
  }

  return parts.join(' ');
}

export function execLocalCommand(
  cmd: string,
  args: string[],
  timeoutMs = 120000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      }
    });
  });
}

export type SshCommandInterceptor = (
  server: ServerRecord,
  remoteCommand: string,
  finalCmd: string
) => Promise<CommandResult> | CommandResult;

let testSshInterceptor: SshCommandInterceptor | null = null;

export function setSshInterceptorForTests(
  interceptor: SshCommandInterceptor | null
): void {
  testSshInterceptor = interceptor;
}

export async function execRemoteSSH(
  server: ServerRecord,
  remoteCommand: string,
  options: {
    zeroImpact?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
    retryBaseDelayMs?: number;
  } = {}
): Promise<CommandResult> {
  const sshUser = (server.ssh_user || 'root').trim();
  const ipAddr = (server.ip_address || '').trim();
  if (
    !sshUser ||
    sshUser.startsWith('-') ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(sshUser) ||
    !ipAddr ||
    ipAddr.startsWith('-') ||
    !/^[A-Za-z0-9._:-]{1,253}$/.test(ipAddr)
  ) {
    throw new Error('Thông tin SSH User hoặc địa chỉ IP máy chủ không hợp lệ.');
  }

  const finalCmd = options.zeroImpact
    ? wrapZeroImpact(remoteCommand)
    : remoteCommand;

  const maxAttempts = Math.max(1, (options.maxRetries ?? 2) + 1);
  const baseDelayMs = options.retryBaseDelayMs ?? 1800;

  let lastRes: CommandResult = { code: 1, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (testSshInterceptor) {
      lastRes = await testSshInterceptor(server, remoteCommand, finalCmd);
    } else {
      const args = [
        ...buildSshBaseArgs(server, { disableMux: attempt > 0 }),
        '--',
        `${sshUser}@${ipAddr}`,
        finalCmd,
      ];
      lastRes = await execLocalCommand(
        'ssh',
        args,
        options.timeoutMs ?? 60000
      );
    }

    if (lastRes.code === 0) {
      return lastRes;
    }

    if (
      !testSshInterceptor &&
      lastRes.code === 255 &&
      /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(
        lastRes.stderr
      ) &&
      Number(server.id) > 0
    ) {
      await ensureServerHostKeyPinned(server.id, undefined, {
        forceRescan: true,
      });
    }

    if (
      attempt + 1 < maxAttempts &&
      isTransientSshTransportError(lastRes.code, lastRes.stderr)
    ) {
      const delayMs =
        baseDelayMs * (attempt + 1) + Math.floor(Math.random() * 350);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    break;
  }

  return lastRes;
}

export async function testSshConnection(server: ServerRecord): Promise<{
  ok: boolean;
  osInfo?: string;
  uptime?: string;
  latencyMs: number;
  hostKeyStatus?: HostKeyStatus;
  hostKeyFingerprint?: string;
  error?: string;
}> {
  const start = Date.now();
  if (server.is_mock) {
    const pinned = await ensureServerHostKeyPinned(server.id);
    await new Promise((r) => setTimeout(r, 250));
    return {
      ok: true,
      osInfo: 'AlmaLinux 9.4 (Mock Simulation Mode)',
      uptime: 'up 84 days, 12:40',
      latencyMs: Date.now() - start,
      hostKeyStatus: pinned.status,
      hostKeyFingerprint: pinned.fingerprint,
    };
  }

  try {
    const pinned = await ensureServerHostKeyPinned(server.id);
    const freshServer =
      (getDb()
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get(server.id) as unknown as ServerRecord | undefined) || server;

    const res = await execRemoteSSH(
      freshServer,
      'uname -sr && (uptime -p 2>/dev/null || uptime)',
      { timeoutMs: 15000 }
    );
    if (res.code !== 0) {
      const cleanedStderr = res.stderr
        .split('\n')
        .filter((line) => !line.trim().startsWith('** '))
        .join('\n')
        .trim();
      let errorMsg =
        cleanedStderr || res.stderr.trim() || `SSH exited with code ${res.code}`;
      if (errorMsg.includes('Permission denied')) {
        const keyUsed = resolveServerKeyPath(freshServer);
        errorMsg += keyUsed
          ? ` — Đã thử khóa "${freshServer.ssh_key_path || keyUsed}". Hãy đảm bảo bạn đã dán Public Key của khóa này vào ~/.ssh/authorized_keys trên VPS.`
          : ' — Máy chủ này chưa được gán SSH Key! Hãy bấm "Quản lý SSH Keys" -> "+ Sinh Khóa SSH Mới" và dán lệnh cài Public Key lên VPS.';
      }
      return {
        ok: false,
        latencyMs: Date.now() - start,
        hostKeyStatus: pinned.status,
        hostKeyFingerprint: pinned.fingerprint,
        error: errorMsg,
      };
    }
    const lines = res.stdout.trim().split('\n');
    return {
      ok: true,
      osInfo: lines[0] || 'Linux',
      uptime: lines[1] || '',
      latencyMs: Date.now() - start,
      hostKeyStatus: pinned.status,
      hostKeyFingerprint: pinned.fingerprint,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

export async function generateSshKeyPair(
  keyName: string,
  keyType: 'ed25519' | 'rsa' = 'ed25519'
): Promise<{
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string;
}> {
  const safeName = validateSafeSshKeyName(keyName);
  const keysDir = path.resolve(getSshKeysDir());
  const privateKeyPath = path.join(keysDir, safeName);
  const pubKeyPath = `${privateKeyPath}.pub`;

  if (fs.existsSync(privateKeyPath) || fs.existsSync(pubKeyPath)) {
    throw new Error(`Khóa SSH "${safeName}" đã tồn tại tại ${privateKeyPath}`);
  }

  const args =
    keyType === 'rsa'
      ? ['-t', 'rsa', '-b', '4096', '-N', '', '-C', `nas-sync-${safeName}`, '-f', privateKeyPath]
      : ['-t', 'ed25519', '-N', '', '-C', `nas-sync-${safeName}`, '-f', privateKeyPath];

  const res = await execLocalCommand('ssh-keygen', args, 20000);
  if (res.code !== 0) {
    throw new Error(`Không thể tạo SSH key: ${res.stderr || res.stdout}`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(pubKeyPath, 0o644);
  }

  const publicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
  const fpRes = await execLocalCommand('ssh-keygen', ['-lf', pubKeyPath], 10000);
  const fingerprint = fpRes.code === 0 ? fpRes.stdout.trim() : '';

  return {
    privateKeyPath,
    publicKey,
    fingerprint,
  };
}

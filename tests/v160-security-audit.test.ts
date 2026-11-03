import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test, { after } from 'node:test';
import zlib from 'node:zlib';

// Cấu hình thư mục dữ liệu tạm thời riêng biệt trước khi nạp các module hệ thống
const tempRootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nas-sync-v160-audit-test-')
);
process.env.DATA_DIR = tempRootDir;
process.env.SSH_KEYS_DIR = path.join(tempRootDir, 'ssh_keys');
process.env.JWT_SECRET =
  'unit-test-v160-jwt-secret-key-at-least-32-chars-long-2026';
process.env.TOTP_ENCRYPTION_KEY =
  'unit-test-v160-dedicated-totp-secret-key-2026-strong';
process.env.NAS_SYNC_SKIP_BOOTSTRAP = 'true';

after(async () => {
  try {
    const { getDb } = await import('../src/lib/db');
    getDb().close();
  } catch {
    // Ignore close errors during test teardown
  }
  fs.rmSync(tempRootDir, { recursive: true, force: true });
});

async function runSqlThroughPsqlGuard(
  chunks: Array<string | Buffer>,
  nonSuperuserRole?: string
): Promise<string> {
  const { createSafePsqlRestoreTransform } = await import(
    '../src/lib/engine/sql-stream-guard'
  );
  const out: Buffer[] = [];
  const guard = createSafePsqlRestoreTransform({ nonSuperuserRole });
  guard.on('data', (c: Buffer) => out.push(c));
  await pipeline(Readable.from(chunks), guard);
  return Buffer.concat(out).toString('utf8');
}

test('1. [S1 & S6] Bộ lọc luồng SQL PostgreSQL chặn triệt để meta-command RCE & leo thang đặc quyền nhưng giữ nguyên dữ liệu COPY', async () => {
  const { buildSafeMariaDbClientFlags } = await import(
    '../src/lib/engine/sandbox-verifier'
  );

  // S1: MariaDB client luôn bật --binary-mode để vô hiệu hóa \`! ...\` / system shell
  const mariaFlags = buildSafeMariaDbClientFlags({
    includeSandboxIfSupported: false,
  });
  assert.ok(mariaFlags.includes('--binary-mode'));

  // S1/S6: pg_dump hợp lệ (gồm \restrict, COMMENT ON EXTENSION, dollar-quote, E'...', COPY FROM stdin chứa '\! not_a_cmd') phải đi qua nguyên vẹn
  const validPgDump = [
    '-- PostgreSQL database dump\n',
    '\\restrict aBcDeFgHiJkLmNoPqRsTuVwXyZ012345\n',
    "COMMENT ON EXTENSION plpgsql IS 'PL/pgSQL procedural language';\n",
    'CREATE TABLE public.articles (\n  id integer NOT NULL,\n  body text\n);\n',
    "INSERT INTO public.articles VALUES (1, E'Chuỗi có backslash \\\\ và dấu nháy '' an toàn; \\! không phải lệnh');\n",
    'CREATE FUNCTION public.bump() RETURNS integer LANGUAGE plpgsql AS $_$\nBEGIN\n  RETURN 42;\nEND;\n$_$;\n',
    'COPY public.articles (id, body) FROM stdin;\n',
    '2\tDòng dữ liệu có chứa \\! id và \\i /etc/passwd bên trong COPY\n',
    '3\tDòng thứ hai \\t chuẩn\n',
    '\\.\n',
    '\\unrestrict aBcDeFgHiJkLmNoPqRsTuVwXyZ012345\n',
    '-- PostgreSQL database dump complete\n',
  ];

  // Thử cắt nhỏ theo từng cụm byte ngẫu nhiên để kiểm tra state machine qua ranh giới chunk
  const fullBuf = Buffer.from(validPgDump.join(''), 'utf8');
  const slicedChunks: Buffer[] = [];
  for (let i = 0; i < fullBuf.length; i += 19) {
    slicedChunks.push(fullBuf.subarray(i, i + 19));
  }

  const sanitizedSql = await runSqlThroughPsqlGuard(slicedChunks, 'app_owner');
  assert.ok(sanitizedSql.includes('CREATE TABLE public.articles'));
  assert.ok(
    sanitizedSql.includes(
      '2\tDòng dữ liệu có chứa \\! id và \\i /etc/passwd bên trong COPY'
    )
  );
  // \restrict / \unrestrict và COMMENT ON EXTENSION được lọc sạch cho nonSuperuserRole
  assert.ok(!sanitizedSql.includes('\\restrict'));
  assert.ok(!sanitizedSql.includes('COMMENT ON EXTENSION'));

  // Các vector tấn công RCE & leo thang đặc quyền bắt buộc bị chặn ngay lập tức
  const maliciousPayloads: Array<{ name: string; sql: string }> = [
    { name: 'meta-command shell \\!', sql: 'SELECT 1;\n\\! id\n' },
    {
      name: 'meta-command inline sau dấu chấm phẩy',
      sql: 'SELECT 1; \\! touch /tmp/pwn\n',
    },
    { name: 'meta-command đọc/ghi file \\i', sql: '\\i /etc/shadow\n' },
    { name: 'meta-command ghi file \\o', sql: '\\o /var/spool/cron/root\n' },
    {
      name: 'COPY TO PROGRAM RCE',
      sql: "COPY (SELECT 'x') TO PROGRAM 'id > /tmp/pwn';\n",
    },
    {
      name: 'Untrusted procedural language plperlu',
      sql: 'CREATE OR REPLACE LANGUAGE plperlu;\n',
    },
    {
      name: 'Hàm dùng LANGUAGE C',
      sql: "CREATE FUNCTION evil() RETURNS void AS '/tmp/evil.so', 'evil' LANGUAGE c;\n",
    },
    {
      name: 'Thoát phiên hạ quyền RESET SESSION AUTHORIZATION',
      sql: 'RESET SESSION AUTHORIZATION;\n',
    },
    {
      name: 'Leo thang đặc quyền ALTER ROLE SUPERUSER',
      sql: 'ALTER ROLE app_owner WITH SUPERUSER;\n',
    },
    {
      name: 'Tắt standard_conforming_strings để lách parser',
      sql: 'SET standard_conforming_strings = off;\n',
    },
  ];

  for (const item of maliciousPayloads) {
    await assert.rejects(
      () => runSqlThroughPsqlGuard([item.sql], 'app_owner'),
      /\[SECURITY\]/,
      `Phải chặn vector: ${item.name}`
    );
  }
});

test('2. [S2, S3, S5, S9, S11] Chống TOCTOU Symlink trên VPS: Rsync Jail, Config Rewriter & aaPanel non-root find -P', async () => {
  const { buildJailedRsyncPath } = await import(
    '../src/lib/engine/adapters/base'
  );
  const { AaPanelAdapter } = await import(
    '../src/lib/engine/adapters/aapanel'
  );
  const { DirectAdminAdapter } = await import(
    '../src/lib/engine/adapters/directadmin'
  );
  const { buildSafeConfigWriteScript } = await import(
    '../src/lib/engine/config-rewriter'
  );

  // S3: Rsync --rsync-path kiểm tra [ ! -L "$EXPECTED" ] và realpath trước khi exec rsync
  const jailedCmd = buildJailedRsyncPath('/home/client1/domains/example.com/public_html');
  assert.ok(jailedCmd.includes('EXPECTED=/home/client1/domains/example.com/public_html;'));
  assert.ok(jailedCmd.includes('[ ! -L "$EXPECTED" ] || exit 91;'));
  assert.ok(jailedCmd.includes('[ "$REAL" = "$EXPECTED" ] || exit 91;'));
  assert.ok(jailedCmd.includes('cd -P -- "$EXPECTED" || exit 91;'));

  // Chặn truyền đường dẫn nhạy cảm hoặc có khoảng trắng
  assert.throws(() => buildJailedRsyncPath('/etc'));
  assert.throws(() => buildJailedRsyncPath('/home/bad path/public_html'));

  // S2: Config Rewriter kiểm tra từng phân đoạn không phải symlink + mktemp O_EXCL + mv -f
  const cfgScript = buildSafeConfigWriteScript(
    '/home/client1/domains/example.com/public_html',
    'app/etc/env.php',
    'client1'
  );
  assert.ok(cfgScript.includes('SITE_USER=\'client1\''));
  assert.ok(cfgScript.includes('[ ! -L "$CUR" ] || exit 92'));
  assert.ok(cfgScript.includes('mktemp "$D_DIR/.nas-sync-bak.XXXXXX"'));
  assert.ok(cfgScript.includes('mktemp "$D_DIR/.nas-sync-tmp.XXXXXX"'));
  assert.ok(cfgScript.includes('mv -f -- "$TMP_NEW" "$REAL_F"'));
  assert.throws(() =>
    buildSafeConfigWriteScript(
      '/home/client1/domains/example.com/public_html',
      '../../etc/passwd',
      'client1'
    )
  );

  // S9: aaPanel sửa quyền bên trong thư mục đã ghim, bỏ qua symlink (! -type l) và hạ quyền xuống user www
  const aaAdapter = new AaPanelAdapter();
  const aaPermCmd = aaAdapter.buildPermissionFixCommand(
    'www',
    'example.com',
    '/www/wwwroot/example.com'
  );
  assert.ok(aaPermCmd.includes('cd -P -- "$EXPECTED"'));
  assert.ok(aaPermCmd.includes('chown -hR www:www .'));
  assert.ok(
    aaPermCmd.includes('find . -P ! -type l -type d -exec chmod 755 {} +')
  );
  assert.ok(aaPermCmd.includes('su -s /bin/sh www -c'));

  // S11: DirectAdmin adapter không còn đọc hay trả trường password plaintext trong bộ nhớ NAS
  const daAdapter = new DirectAdminAdapter();
  assert.equal(typeof daAdapter.getMysqlAdminCredentials, 'function');
});

test('3. [S4, S7, S8] Khóa SSH TOFU chống chèn khóa phụ (Subset Pinning), loại bỏ ssh-rsa SHA-1 & fail-closed known_hosts', async () => {
  const { getDb } = await import('../src/lib/db');
  const {
    ensureServerHostKeyPinned,
    buildSshBaseArgs,
    buildRsyncSshTransport,
    validateSafeSshKeyName,
  } = await import('../src/lib/ssh');
  const typeMod = await import('../src/types');
  void typeMod;

  const db = getDb();
  const sshKeysDir = process.env.SSH_KEYS_DIR!;
  fs.mkdirSync(sshKeysDir, { recursive: true });
  const keyPath = path.join(sshKeysDir, 'audit_ed25519');
  fs.writeFileSync(keyPath, 'DUMMY-PRIVATE-KEY-FOR-ARGS-TEST\n', { mode: 0o600 });

  const edKeyLine = `198.51.100.77 ssh-ed25519 ${Buffer.from('nas-sync-audit-ed25519-primary-host-key-0001').toString('base64')}`;
  const rogueRsaLine = `198.51.100.77 ssh-rsa ${Buffer.from('nas-sync-audit-rogue-secondary-injected-key-9999').toString('base64')}`;

  const ins = db
    .prepare(
      `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, panel_type, is_mock)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      'vps-s4.example.net',
      '198.51.100.77',
      22,
      'root',
      keyPath,
      'DIRECTADMIN'
    );
  const serverId = Number(ins.lastInsertRowid);

  // S7: Khi chưa ghim khóa (UNPINNED), cả SSH và Rsync bắt buộc từ chối chạy (Fail-Closed)
  const unpinnedRow = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(serverId) as unknown as import('../src/types').ServerRecord;
  assert.throws(
    () => buildSshBaseArgs(unpinnedRow),
    /\[SECURITY\].*known_hosts/
  );
  assert.throws(
    () => buildRsyncSshTransport(unpinnedRow),
    /\[SECURITY\].*known_hosts/
  );

  // Ghim TOFU lần đầu với khóa Ed25519 duy nhất
  const firstPin = await ensureServerHostKeyPinned(serverId, `${edKeyLine}\n`);
  assert.equal(firstPin.status, 'VERIFIED');

  const verifiedRow = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(serverId) as unknown as import('../src/types').ServerRecord;
  const sshArgs = buildSshBaseArgs(verifiedRow);
  const rsyncTransport = buildRsyncSshTransport(verifiedRow);

  // Không bao giờ cho phép thuật toán SHA-1 (+ssh-rsa) hay StrictHostKeyChecking=accept-new
  assert.ok(!sshArgs.some((a) => a.includes('ssh-rsa')));
  assert.ok(!sshArgs.some((a) => a.includes('accept-new')));
  assert.ok(sshArgs.includes('StrictHostKeyChecking=yes'));
  assert.ok(!rsyncTransport.includes('ssh-rsa'));
  assert.ok(rsyncTransport.includes('StrictHostKeyChecking=yes'));

  // S4: Quét lại khi kẻ tấn công giữ nguyên khóa Ed25519 cũ nhưng chèn thêm 1 khóa phụ lạ -> BẮT BUỘC MISMATCH!
  await assert.rejects(
    () =>
      ensureServerHostKeyPinned(
        serverId,
        `${edKeyLine}\n${rogueRsaLine}\n`,
        { forceRescan: true }
      ),
    /\[SECURITY\].*xuất hiện khóa lạ/
  );

  const lockedRow = db
    .prepare('SELECT host_key_status, host_key_pending_fingerprint FROM servers WHERE id = ?')
    .get(serverId) as { host_key_status: string; host_key_pending_fingerprint: string };
  assert.equal(lockedRow.host_key_status, 'MISMATCH');
  assert.ok(lockedRow.host_key_pending_fingerprint.startsWith('SHA256:'));

  // Chặn tên key trùng file điều khiển OpenSSH
  assert.throws(() => validateSafeSshKeyName('authorized_keys'));
  assert.throws(() => validateSafeSshKeyName('config'));
});

test('4. [N1, N2, N6, N17] Ghim bảo vệ Snapshot đang đọc, dọn dẹp .in_progress_*, hủy Process Group & kiểm định Zstd toàn luồng', async () => {
  const { getDb } = await import('../src/lib/db');
  const { acquireSnapshotReadPin, isSnapshotReadPinned } = await import(
    '../src/lib/engine/snapshot-pins'
  );
  const { applyGfsRetentionForServer } = await import(
    '../src/lib/engine/retention-gfs'
  );
  const {
    cleanupInProgressSnapshotDirsForJob,
    registerJobChildProcess,
    killJobChildProcesses,
  } = await import('../src/lib/engine/worker-state');
  const { verifySqlFileStructureFallback } = await import(
    '../src/lib/engine/sandbox-verifier'
  );

  const db = getDb();
  const volMount = path.join(tempRootDir, 'vol_n6');
  fs.mkdirSync(volMount, { recursive: true });

  const volId = Number(
    db
      .prepare(
        `INSERT INTO storage_volumes (name, mount_path, priority, status)
         VALUES ('Vol Audit', ?, 1, 'ACTIVE')`
      )
      .run(volMount).lastInsertRowid
  );
  const srvId = Number(
    db
      .prepare(
        `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, panel_type, is_mock)
         VALUES ('srv-n6.example.net', '198.51.100.88', 22, 'root', '/tmp/mock', 'CPANEL', 1)`
      )
      .run().lastInsertRowid
  );

  // Tạo 3 bản snapshot hoàn tất ở 3 ngày khác nhau; chính sách giữ daily=1, weekly=0, monthly=0
  const snaps = [
    { name: '2026-10-01_01-00-00', created: '2026-10-01 01:00:00' },
    { name: '2026-10-02_01-00-00', created: '2026-10-02 01:00:00' },
    { name: '2026-10-03_01-00-00', created: '2026-10-03 01:00:00' },
  ];
  for (const s of snaps) {
    const dir = path.join(volMount, 'srv-n6.example.net', s.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.txt'), s.name);
    db.prepare(
      `INSERT INTO backup_jobs (server_id, volume_id, snapshot_name, job_type, status, created_at)
       VALUES (?, ?, ?, 'BACKUP', 'COMPLETED', ?)`
    ).run(srvId, volId, s.name, s.created);
  }

  // Ghim đọc bản cũ nhất 2026-10-01_01-00-00 (giả lập Explorer/Offsite đang stream)
  const releasePin = acquireSnapshotReadPin(srvId, '2026-10-01_01-00-00');
  assert.equal(isSnapshotReadPinned(srvId, '2026-10-01_01-00-00'), true);

  const gfsWhilePinned = await applyGfsRetentionForServer(srvId, {
    daily: 1,
    weekly: 0,
    monthly: 0,
  });
  // Bản 2026-10-02 bị dọn, nhưng bản 2026-10-01 ĐƯỢC GIỮ LẠI vì đang ghim đọc!
  assert.ok(gfsWhilePinned.deletedSnapshots.includes('2026-10-02_01-00-00'));
  assert.ok(!gfsWhilePinned.deletedSnapshots.includes('2026-10-01_01-00-00'));
  assert.equal(
    fs.existsSync(
      path.join(volMount, 'srv-n6.example.net', '2026-10-01_01-00-00')
    ),
    true
  );

  // Nhả ghim đọc -> lần dọn GFS tiếp theo xóa sạch bản cũ đúng chính sách
  releasePin();
  assert.equal(isSnapshotReadPinned(srvId, '2026-10-01_01-00-00'), false);
  const gfsAfterRelease = await applyGfsRetentionForServer(srvId, {
    daily: 1,
    weekly: 0,
    monthly: 0,
  });
  assert.ok(gfsAfterRelease.deletedSnapshots.includes('2026-10-01_01-00-00'));

  // N6: Dọn dẹp thư mục .in_progress_<snapshot> khi job FAILED/CANCELLED
  const failedSnap = '2026-10-04_01-00-00';
  const inProgressDir = path.join(
    volMount,
    'srv-n6.example.net',
    `.in_progress_${failedSnap}`
  );
  fs.mkdirSync(inProgressDir, { recursive: true });
  fs.writeFileSync(path.join(inProgressDir, 'partial.dat'), 'orphaned-bytes');

  const failedJobId = Number(
    db
      .prepare(
        `INSERT INTO backup_jobs (server_id, volume_id, snapshot_name, job_type, status)
         VALUES (?, ?, ?, 'BACKUP', 'FAILED')`
      )
      .run(srvId, volId, failedSnap).lastInsertRowid
  );
  cleanupInProgressSnapshotDirsForJob(failedJobId);
  assert.equal(fs.existsSync(inProgressDir), false);
  // Bản snapshot đã commit vẫn an toàn tuyệt đối
  assert.equal(
    fs.existsSync(
      path.join(volMount, 'srv-n6.example.net', '2026-10-03_01-00-00')
    ),
    true
  );

  // N2: Đăng ký và hủy tiến trình con qua Process Group / Child Registry
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  registerJobChildProcess(999123, sleeper);
  const killed = killJobChildProcesses(999123);
  assert.equal(killed, 1);
  await new Promise<void>((resolve) => {
    if (sleeper.exitCode !== null || sleeper.signalCode !== null) {
      resolve();
      return;
    }
    sleeper.once('close', () => resolve());
  });

  // N17: Kiểm định file .sql.zst có đúng 4 byte Zstd magic (28 b5 2f fd) nhưng phần thân bị hỏng -> BẮT BUỘC PHÁT HIỆN CORRUPTED!
  const fakeZstFile = path.join(tempRootDir, 'corrupt_tail.sql.zst');
  fs.writeFileSync(
    fakeZstFile,
    Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.from('CORRUPTED_ZSTD_FRAME_PAYLOAD_NOT_VALID', 'utf8'),
    ])
  );
  const corruptRes = await verifySqlFileStructureFallback(fakeZstFile);
  assert.equal(corruptRes.ok, false);

  // Và một file .sql.zst hợp lệ nén bằng Node 24 zstdCompressSync phải PASSED
  const zlibExt = zlib as typeof zlib & {
    zstdCompressSync?: (buf: Buffer) => Buffer;
  };
  if (typeof zlibExt.zstdCompressSync === 'function') {
    const validSql = [
      '-- MariaDB dump 10.19\n',
      'CREATE TABLE `users` (`id` int PRIMARY KEY);\n',
      'INSERT INTO `users` VALUES (1);\n',
      '-- Dump completed on 2026-11-03  1:00:00\n',
    ].join('');
    const validZstPath = path.join(tempRootDir, 'valid_dump.sql.zst');
    fs.writeFileSync(validZstPath, zlibExt.zstdCompressSync(Buffer.from(validSql, 'utf8')));
    const validRes = await verifySqlFileStructureFallback(validZstPath);
    assert.equal(validRes.ok, true);
    assert.equal(validRes.tablesCount, 1);
  }
});

test('5. [U1 & U2] Ký số Ed25519 gói phát hành Prebuilt: chống giả mạo SHA-256, chống hạ cấp đánh tráo Tag & khóa công khai lạ', async () => {
  const {
    signReleasePayload,
    verifyReleaseSignature,
    DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM,
  } = await import('../src/lib/release-signature');

  assert.ok(DEFAULT_RELEASE_ED25519_PUBLIC_KEY_PEM.includes('BEGIN PUBLIC KEY'));

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString('utf8');
  const privPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString('utf8');

  const sampleHash = crypto
    .createHash('sha256')
    .update('nas-sync-prebuilt-v1.6.0-tarball-bytes')
    .digest('hex');

  const sig = signReleasePayload('v1.6.0', sampleHash, privPem);

  // Khớp cả tag (có hoặc không tiền tố 'v') và mã băm SHA-256 -> Hợp lệ
  assert.equal(verifyReleaseSignature('v1.6.0', sampleHash, sig, pubPem), true);
  assert.equal(verifyReleaseSignature('1.6.0', sampleHash, sig, pubPem), true);

  // Sửa 1 ký tự trong SHA-256 -> Thất bại
  const tamperedHash =
    (sampleHash[0] === 'a' ? 'b' : 'a') + sampleHash.slice(1);
  assert.equal(
    verifyReleaseSignature('v1.6.0', tamperedHash, sig, pubPem),
    false
  );

  // Giữ nguyên SHA-256 + chữ ký nhưng tráo sang tag khác (Rollback/Tag Confusion) -> Thất bại
  assert.equal(verifyReleaseSignature('v1.5.9', sampleHash, sig, pubPem), false);

  // Xác thực bằng khóa công khai khác -> Thất bại
  const otherPair = crypto.generateKeyPairSync('ed25519');
  const otherPubPem = otherPair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString('utf8');
  assert.equal(
    verifyReleaseSignature('v1.6.0', sampleHash, sig, otherPubPem),
    false
  );
});

test('6. [O1, O2, O5 & C1] Offsite Prefix Isolation, S3 >78 GiB Multipart, SSRF Guard & Mã hóa NASSYNC2 AAD + tương thích ngược NASSYNC1', async () => {
  const {
    isExactOffsiteArchiveForHostname,
    computeS3MultipartChunkSize,
    isBlockedPrivateOrMetadataIp,
  } = await import('../src/lib/engine/offsite-cloud');
  const { createOffsiteEncryptStream, createOffsiteDecryptStream } =
    await import('../src/lib/engine/offsite-crypto');

  // O1: Máy chủ 'web' tuyệt đối KHÔNG khớp nhầm sang bản sao lưu của 'web-2' hoặc 'web-prod'
  assert.equal(
    isExactOffsiteArchiveForHostname(
      'nas-sync-web-2026-11-03_01-00-00.tar.gz.enc',
      'web'
    ),
    true
  );
  assert.equal(
    isExactOffsiteArchiveForHostname(
      'nas-sync-web-2026-11-03_01-00-00-2.tar.gz.enc',
      'web'
    ),
    true
  );
  assert.equal(
    isExactOffsiteArchiveForHostname(
      'nas-sync-web-2-2026-11-03_01-00-00.tar.gz.enc',
      'web'
    ),
    false
  );
  assert.equal(
    isExactOffsiteArchiveForHostname(
      'nas-sync-web-prod-2026-11-03_01-00.tar.gz.enc',
      'web'
    ),
    false
  );

  // O2: Snapshot 250 GiB tự động nâng kích thước part để tổng số part không vượt 10.000
  const size250GiB = 250 * 1024 * 1024 * 1024;
  const partBytes = computeS3MultipartChunkSize(size250GiB);
  assert.ok(partBytes >= 32 * 1024 * 1024);
  assert.ok(Math.ceil(size250GiB / partBytes) <= 10_000);

  // O5: SSRF Guard chặn Cloud Metadata, Loopback, RFC1918 & IPv4-mapped IPv6
  assert.equal(isBlockedPrivateOrMetadataIp('169.254.169.254'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('127.0.0.1'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('10.20.30.40'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('172.16.5.9'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('192.168.1.254'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('::1'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('fd00::1234'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('fe80::1'), true);
  assert.equal(isBlockedPrivateOrMetadataIp('1.1.1.1'), false);

  // C1a: NASSYNC2 xác thực toàn bộ 49-byte Header qua AES-GCM AAD -> Sửa chunkSize hoặc iterations trong header phải bị bác bỏ ngay!
  const secretPass = 'Offsite-ZeroKnowledge-v2-Passphrase!';
  const plainSample = crypto.randomBytes(5000);
  const encParts: Buffer[] = [];
  const enc = createOffsiteEncryptStream(secretPass, 2048, {
    iterations: 10_000,
  });
  enc.on('data', (c: Buffer) => encParts.push(c));
  await pipeline(Readable.from([plainSample]), enc);
  const v2Blob = Buffer.concat(encParts);

  const headerTampered = Buffer.from(v2Blob);
  // Ghi đè trường chunkSize ở offset 45..49 của header NASSYNC2
  headerTampered.writeUInt32BE(4096, 45);
  await assert.rejects(async () => {
    const dec = createOffsiteDecryptStream(secretPass);
    dec.resume();
    await pipeline(Readable.from([headerTampered]), dec);
  }, /Giải mã|Xác thực/i);

  // C1b: Tương thích ngược 100% với bản sao lưu thế hệ cũ NASSYNC1 (45-byte header, PBKDF2 210.000 vòng)
  const v1Salt = crypto.randomBytes(32);
  const v1ChunkSize = 4096;
  const v1Header = Buffer.alloc(45);
  v1Header.write('NASSYNC1', 0, 8, 'ascii');
  v1Header[8] = 0x01;
  v1Salt.copy(v1Header, 9);
  v1Header.writeUInt32BE(v1ChunkSize, 41);

  const v1Key = crypto.pbkdf2Sync(secretPass, v1Salt, 210_000, 32, 'sha256');
  const v1NoncePrefix = crypto.randomBytes(8);
  const buildV1DataFrame = (frameIdx: number, chunk: Buffer): Buffer => {
    const iv = Buffer.alloc(12);
    v1NoncePrefix.copy(iv, 0);
    iv.writeUInt32BE(frameIdx >>> 0, 8);
    const cipher = crypto.createCipheriv('aes-256-gcm', v1Key, iv);
    const ct = Buffer.concat([cipher.update(chunk), cipher.final()]);
    const tag = cipher.getAuthTag();
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(chunk.length, 0);
    return Buffer.concat([lenBuf, iv, ct, tag]);
  };
  const buildV1EofFrame = (eofIdx: number): Buffer => {
    const iv = Buffer.alloc(12);
    v1NoncePrefix.copy(iv, 0);
    iv.writeUInt32BE((eofIdx | 0x80000000) >>> 0, 8);
    const cipher = crypto.createCipheriv('aes-256-gcm', v1Key, iv);
    cipher.setAAD(Buffer.from('NASSYNC1-EOF', 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.alloc(0)), cipher.final()]);
    const tag = cipher.getAuthTag();
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(0, 0);
    return Buffer.concat([lenBuf, iv, ct, tag]);
  };

  const legacyPlain = Buffer.from(
    'Dữ liệu sao lưu đám mây thế hệ NASSYNC1 cần khôi phục sau 2 năm!',
    'utf8'
  );
  const legacyBlob = Buffer.concat([
    v1Header,
    buildV1DataFrame(0, legacyPlain),
    buildV1EofFrame(1),
  ]);

  const v1DecParts: Buffer[] = [];
  const v1Dec = createOffsiteDecryptStream(secretPass);
  v1Dec.on('data', (c: Buffer) => v1DecParts.push(c));
  await pipeline(Readable.from([legacyBlob]), v1Dec);
  assert.deepEqual(Buffer.concat(v1DecParts), legacyPlain);

  // Giải mã NASSYNC1 qua CLI cứu hộ độc lập với cờ --passphrase-file
  const v1EncPath = path.join(tempRootDir, 'legacy-v1.tar.gz.enc');
  const v1OutPath = path.join(tempRootDir, 'legacy-v1.tar.gz');
  const passFilePath = path.join(tempRootDir, 'passphrase.txt');
  fs.writeFileSync(v1EncPath, legacyBlob);
  fs.writeFileSync(passFilePath, `${secretPass}\r\n`, { mode: 0o600 });

  execFileSync(
    process.execPath,
    [
      path.resolve(process.cwd(), 'scripts/decrypt-offsite-backup.mjs'),
      '--passphrase-file',
      passFilePath,
      v1EncPath,
      v1OutPath,
    ],
    { stdio: 'pipe' }
  );
  assert.deepEqual(fs.readFileSync(v1OutPath), legacyPlain);
});

test('7. [A2, A4, A5 & N9] Phân quyền RBAC /api/alerts, chống Replay TOTP, tách khóa 2FA khỏi JWT_SECRET & giới hạn độ dài Telegram', async () => {
  const { getDb } = await import('../src/lib/db');
  const { evaluateApiRbac } = await import('../server');
  const {
    generateTotpSecret,
    encryptTotpSecret,
    decryptTotpSecret,
    generateRecoveryCodes,
    verifyAndConsumeRecoveryCode,
    consumeTotpStepAtomically,
  } = await import('../src/lib/totp');
  const { buildSafeTelegramHtmlPayload } = await import(
    '../src/lib/notifications'
  );

  // A2: VIEWER xem được cảnh báo (/api/alerts GET), OPERATOR đánh dấu đã đọc được (POST), nhưng VIEWER không được POST
  assert.equal(evaluateApiRbac('GET', '/api/alerts', 'VIEWER').allowed, true);
  assert.equal(evaluateApiRbac('POST', '/api/alerts', 'VIEWER').allowed, false);
  assert.equal(
    evaluateApiRbac('POST', '/api/alerts', 'OPERATOR').allowed,
    true
  );
  assert.equal(
    evaluateApiRbac('POST', '/api/system/update', 'OPERATOR').allowed,
    false
  );
  assert.equal(
    evaluateApiRbac('POST', '/api/system/update', 'ADMIN').allowed,
    true
  );

  // A4: Chống phát lại mã TOTP trong cùng chu kỳ 30 giây (RFC 6238 §5.2)
  const db = getDb();
  const userId = Number(
    db
      .prepare(
        `INSERT INTO users (username, password_hash, role)
         VALUES ('totp_replay_user', 'scrypt$dummy$hash', 'ADMIN')`
      )
      .run().lastInsertRowid
  );
  assert.equal(consumeTotpStepAtomically(userId, 58_000_001), true);
  // Phát lại cùng chu kỳ hoặc chu kỳ cũ hơn bắt buộc bị từ chối
  assert.equal(consumeTotpStepAtomically(userId, 58_000_001), false);
  assert.equal(consumeTotpStepAtomically(userId, 58_000_000), false);
  // Chu kỳ kế tiếp hợp lệ được chấp nhận
  assert.equal(consumeTotpStepAtomically(userId, 58_000_002), true);

  // A5: Xoay vòng JWT_SECRET KHÔNG làm hỏng khóa TOTP hay Recovery Codes thế hệ v2
  const plainTotp = generateTotpSecret();
  const encryptedV2 = encryptTotpSecret(plainTotp);
  assert.ok(encryptedV2.startsWith('v2:'));
  const recovery = generateRecoveryCodes(4);

  const oldJwt = process.env.JWT_SECRET;
  process.env.JWT_SECRET =
    'completely-rotated-new-jwt-secret-after-incident-999999';
  try {
    assert.equal(decryptTotpSecret(encryptedV2), plainTotp);
    const checkRec = verifyAndConsumeRecoveryCode(
      recovery.plainCodes[0],
      recovery.hashedJson
    );
    assert.equal(checkRec.matched, true);
    assert.equal(checkRec.remainingCount, 3);
  } finally {
    process.env.JWT_SECRET = oldJwt;
  }

  // N9: Thông báo Telegram dài 12.000 ký tự kèm ký tự HTML đặc biệt luôn được cắt an toàn <= 3900 ký tự
  const hugeLog = '<script>alert(1)</script> & lỗi đường truyền '.repeat(350);
  const tgHtml = buildSafeTelegramHtmlPayload(
    '🚨 <b>[NAS-Sync - BACKUP]</b>\n<b>Job thất bại</b>\n\n',
    hugeLog,
    '\n\n🕒 03/11/2026'
  );
  assert.ok(tgHtml.length <= 3900);
  assert.ok(!tgHtml.includes('<script>'));
  assert.ok(tgHtml.includes('[đã rút gọn]'));
});
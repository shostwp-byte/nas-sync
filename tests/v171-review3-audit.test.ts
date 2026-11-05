import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test, { after, before } from 'node:test';

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nas-sync-v171-review3-')
);
const tempDataDir = path.join(tempRoot, 'app_data');
const tempKeysDir = path.join(tempRoot, 'ssh_keys');
const tempVolDir = path.join(tempRoot, 'vol1');

function resolveShBinary(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          'sh',
          'C:\\Users\\ADMIN\\AppData\\Local\\GitHubDesktop\\app-3.6.10\\resources\\app\\git\\usr\\bin\\sh.exe',
          'C:\\Program Files\\Git\\bin\\sh.exe',
          'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
        ]
      : ['/bin/sh', 'sh'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-c', 'exit 0'], { stdio: 'ignore' });
      if (r.status === 0) return bin;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function resolveBashBinary(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          'bash',
          'C:\\Users\\ADMIN\\AppData\\Local\\GitHubDesktop\\app-3.6.10\\resources\\app\\git\\usr\\bin\\bash.exe',
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
          'sh',
        ]
      : ['bash', '/bin/bash', '/usr/bin/bash', '/bin/sh', 'sh'];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-c', 'exit 0'], { stdio: 'ignore' });
      if (r.status === 0) return bin;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

async function runSqlThroughGuard(
  sql: string,
  byteByByte = false
): Promise<string> {
  const { createSafePsqlRestoreTransform } = await import(
    '../src/lib/engine/sql-stream-guard'
  );
  const src = new PassThrough();
  const guard = createSafePsqlRestoreTransform();
  const outChunks: Buffer[] = [];
  guard.on('data', (c: Buffer) => outChunks.push(Buffer.from(c)));

  const pipePromise = pipeline(src, guard);
  const buf = Buffer.from(sql, 'utf8');
  if (byteByByte) {
    for (let i = 0; i < buf.length; i++) {
      src.write(buf.subarray(i, i + 1));
    }
  } else {
    src.write(buf);
  }
  src.end();
  await pipePromise;
  return Buffer.concat(outChunks).toString('utf8');
}

before(async () => {
  fs.mkdirSync(tempDataDir, { recursive: true });
  fs.mkdirSync(tempKeysDir, { recursive: true });
  fs.mkdirSync(tempVolDir, { recursive: true });
  process.env.DATA_DIR = tempDataDir;
  process.env.SSH_KEYS_DIR = tempKeysDir;
  process.env.STORAGE_VOLUMES = tempVolDir;
  process.env.VOLUME_MIN_FREE_GB = '0';
  process.env.VOLUME_MAX_USAGE_PERCENT = '99';
  process.env.JWT_SECRET =
    'v171-review3-audit-jwt-secret-key-at-least-32-chars!!';

  const { resetDbConnectionForTests, getDb } = await import('../src/lib/db');
  resetDbConnectionForTests();
  getDb();
});

after(async () => {
  const { resetDbConnectionForTests } = await import('../src/lib/db');
  resetDbConnectionForTests();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('1. [Wave 1 & 2 — S13, S9] Thứ tự cờ --defaults-extra-file đứng trước --binary-mode khi Restore MySQL & cú pháp chuẩn find -P . trên aaPanel', async () => {
  const { buildRemoteMysqlRestoreInnerCommand } = await import(
    '../src/lib/engine/restore-worker'
  );
  const { AaPanelAdapter } = await import(
    '../src/lib/engine/adapters/aapanel'
  );

  // S13: --defaults-extra-file PHẢI là tham số đầu tiên ngay sau binary mysql (trước --binary-mode)
  const restoreCmd = buildRemoteMysqlRestoreInnerCommand(
    { user: 'root', defaultsFile: '/root/.my.cnf' },
    'cpuser_wpdb'
  );
  assert.equal(
    restoreCmd,
    "mysql --defaults-extra-file='/root/.my.cnf' --binary-mode 'cpuser_wpdb'",
    'Lệnh mysql restore phải đặt --defaults-extra-file ngay trước --binary-mode'
  );

  // S9: Cú pháp find -P . ! -type l (cờ -P đặt trước đường dẫn .)
  const aaAdapter = new AaPanelAdapter();
  const permCmd = aaAdapter.buildPermissionFixCommand(
    'www',
    'shop.example.com',
    '/www/wwwroot/shop.example.com'
  );
  assert.ok(permCmd.includes('find -P . ! -type l'));
  assert.equal(permCmd.includes('find . -P'), false);

  const shBin = resolveShBinary();
  if (shBin) {
    const sampleDir = fs.mkdtempSync(path.join(tempRoot, 'find-p-check-'));
    fs.writeFileSync(path.join(sampleDir, 'index.php'), '<?php echo 1;');
    const run = spawnSync(
      shBin,
      ['-c', 'cd "$1" && find -P . ! -type l -print >/dev/null', 'sh', sampleDir],
      { encoding: 'utf8' }
    );
    assert.equal(
      run.status,
      0,
      `Lệnh POSIX "find -P . ! -type l" phải thực thi thành công (stderr: ${run.stderr})`
    );
  }
});

test('2. [Wave 3 — S12, S6, N29] Chặn triệt để cả 6 kỹ thuật lách bộ lọc PostgreSQL (chunk & 1-byte), từ chối psql thiếu \\restrict, kết nối bằng role khách & truyền dòng COPY > 100 KiB', async () => {
  const {
    assertPostgresRestoreSecurityCapabilities,
    buildNonSuperuserPostgresRestoreRemoteCommand,
    detectPostgresDumpFormat,
  } = await import('../src/lib/engine/postgres-streamer');

  const maliciousPayloads: Array<{ name: string; sql: string }> = [
    {
      name: '1. Chuỗi định danh kép giả mạo COPY ... FROM stdin',
      sql: 'SELECT 1 AS "COPY x FROM stdin";\n\\! id\n',
    },
    {
      name: '2. Ngắt chú thích dòng bằng \\r để chèn meta-command psql',
      sql: '-- innocent comment\r\\! id\n',
    },
    {
      name: '3. Dollar-quote không hợp lệ $$x$ mở giả mạo',
      sql: 'CREATE TABLE a$$x$ (id int);\n\\! id\n',
    },
    {
      name: '4. Hạ cấp SET standard_conforming_strings = off',
      sql: "SET standard_conforming_strings = off;\nSELECT 'x\\';\\n\\\\! id\n';\n",
    },
    {
      name: '5. Đổi bảng mã client đa byte không phải UTF-8 (SJIS/BIG5/GBK)',
      sql: "SET client_encoding = 'SJIS';\nSELECT 1;\n",
    },
    {
      name: "6. Hậu tố định danh a$E'\\' không phải chuỗi thoát E'...'",
      sql: "SELECT a$E'\\';\n\\! id\n",
    },
    {
      name: '7. Thực thi lệnh hệ điều hành qua COPY ... PROGRAM',
      sql: "COPY t FROM PROGRAM 'id';\n",
    },
    {
      name: '8. Chuyển quyền phiên bằng SET SESSION AUTHORIZATION',
      sql: 'SET SESSION AUTHORIZATION postgres;\n',
    },
  ];

  for (const item of maliciousPayloads) {
    await assert.rejects(
      () => runSqlThroughGuard(item.sql, false),
      /\[SECURITY\]/,
      `Phải chặn kịch bản (full chunk): ${item.name}`
    );
    await assert.rejects(
      () => runSqlThroughGuard(item.sql, true),
      /\[SECURITY\]/,
      `Phải chặn kịch bản (cắt nhỏ từng 1 byte qua ranh giới chunk): ${item.name}`
    );
  }

  // N29: Cho phép bản pg_dump hợp lệ + dòng COPY_DATA dài > 120 KiB đi qua không bị chặn ở 64 KiB
  const bigCopyRow = `1\t${'X'.repeat(130_000)}`;
  const validDump = [
    "SET client_encoding = 'UTF8';",
    'SET standard_conforming_strings = on;',
    "SELECT pg_catalog.set_config('search_path', '', false);",
    'CREATE TABLE public.articles (id integer, body text);',
    'COPY public.articles (id, body) FROM stdin;',
    bigCopyRow,
    '\\.',
    '',
  ].join('\n');

  const filteredOut = await runSqlThroughGuard(validDump, false);
  assert.ok(filteredOut.includes(bigCopyRow));

  // S12: Nhận diện magic header PGDMP & fail-closed khi psql đích thiếu \restrict
  const customFile = path.join(tempRoot, 'sample.pgdump');
  fs.writeFileSync(
    customFile,
    Buffer.concat([Buffer.from('PGDMP', 'ascii'), Buffer.from([1, 14, 0, 0])])
  );
  assert.equal(await detectPostgresDumpFormat(customFile), 'CUSTOM');

  const plainFile = path.join(tempRoot, 'sample.sql');
  fs.writeFileSync(plainFile, 'SELECT 1;\n', 'utf8');
  assert.equal(await detectPostgresDumpFormat(plainFile), 'PLAIN_SQL');

  assert.throws(
    () =>
      assertPostgresRestoreSecurityCapabilities({
        dumpFormat: 'PLAIN_SQL',
        psqlSupportsRestrict: false,
        authMode: 'TCP_EPHEMERAL',
        pgRestoreAvailable: true,
      }),
    /\\restrict/
  );
  assert.throws(
    () =>
      assertPostgresRestoreSecurityCapabilities({
        dumpFormat: 'PLAIN_SQL',
        psqlSupportsRestrict: true,
        authMode: 'NONE',
        pgRestoreAvailable: true,
      }),
    /superuser postgres/
  );
  assert.doesNotThrow(() =>
    assertPostgresRestoreSecurityCapabilities({
      dumpFormat: 'PLAIN_SQL',
      psqlSupportsRestrict: true,
      authMode: 'TCP_EPHEMERAL',
      pgRestoreAvailable: false,
    })
  );
  assert.doesNotThrow(() =>
    assertPostgresRestoreSecurityCapabilities({
      dumpFormat: 'CUSTOM',
      psqlSupportsRestrict: false,
      authMode: 'TCP_EPHEMERAL',
      pgRestoreAvailable: true,
    })
  );

  // S6: Luôn kết nối bằng role không phải superuser (không bao giờ chạy psql/pg_restore dưới quyền postgres)
  const nonSuperSqlCmd = buildNonSuperuserPostgresRestoreRemoteCommand({
    dumpFormat: 'PLAIN_SQL',
    authMode: 'TCP_EPHEMERAL',
    pgPort: 5432,
    safeTargetDb: 'tenant_db',
    ownerRole: 'tenant_user',
    ephemeralRole: 'nassync_rst_01',
    ephemeralPass: 'ephemeralSecretPass1234',
  });
  assert.ok(nonSuperSqlCmd.includes("psql -X -h 127.0.0.1 -p 5432 -U 'nassync_rst_01'"));
  assert.equal(nonSuperSqlCmd.includes('su - postgres -c "psql -X'), false);
  assert.equal(nonSuperSqlCmd.includes('runuser -u postgres'), false);

  const nonSuperCustomCmd = buildNonSuperuserPostgresRestoreRemoteCommand({
    dumpFormat: 'CUSTOM',
    authMode: 'TCP_EPHEMERAL',
    pgPort: 5432,
    safeTargetDb: 'tenant_db',
    ownerRole: 'tenant_user',
    ephemeralRole: 'nassync_rst_02',
    ephemeralPass: 'ephemeralSecretPass5678',
  });
  assert.ok(nonSuperCustomCmd.includes('pg_restore'));
  assert.ok(nonSuperCustomCmd.includes('--no-owner'));
  assert.ok(nonSuperCustomCmd.includes('--no-privileges'));
});

test('3. [Wave 4 & 7 — N18, N21, N22, N27, S14] Thống nhất số lần thử BullMQ + Worker, cảnh báo CRITICAL khi hết retry, cô lập user MariaDB Sandbox & tước cờ setuid rsync', async () => {
  const { getDb } = await import('../src/lib/db');
  const {
    MAX_BACKUP_RETRIES,
    cancelRunningOrQueuedJob,
    computeBullMqBackupAttempts,
    finalizeExhaustedBackupJobIfNeeded,
  } = await import('../src/lib/engine/queue');
  const { buildMorningDigestSummary } = await import(
    '../src/lib/engine/morning-digest'
  );
  const { buildIsolatedSandboxVerifierUsername } = await import(
    '../src/lib/engine/sandbox-verifier'
  );
  const { executeRestoreJob } = await import(
    '../src/lib/engine/restore-worker'
  );
  const { buildRsyncPullArgs } = await import('../src/lib/engine/rsync-runner');

  // N18: MAX_BACKUP_RETRIES = 10 -> lần đầu xếp hàng phải có 11 lượt thực thi (1 lượt gốc + 10 lượt retry)
  assert.equal(computeBullMqBackupAttempts(0), MAX_BACKUP_RETRIES + 1);
  assert.equal(computeBullMqBackupAttempts(9), 2);
  assert.equal(computeBullMqBackupAttempts(10), 1);

  const db = getDb();
  const srvRes = db
    .prepare(
      `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, panel_type, is_mock)
       VALUES ('n18-vps.example.com', '198.51.100.18', 22, 'root', 'DIRECTADMIN', 1)`
    )
    .run();
  const serverId = Number(srvRes.lastInsertRowid);

  const stalledJobRes = db
    .prepare(
      `INSERT INTO backup_jobs (job_type, server_id, snapshot_name, status, retry_count, current_phase)
       VALUES ('BACKUP', ?, '2026-11-03_01-00-00', 'INTERRUPTED', ?, 'Mất mạng tạm thời')`
    )
    .run(serverId, MAX_BACKUP_RETRIES);
  const stalledJobId = Number(stalledJobRes.lastInsertRowid);

  // Morning Digest phải đếm cả các job INTERRUPTED bị kẹt khi đã dùng hết số lần retry
  const digestBefore = buildMorningDigestSummary();
  assert.ok(digestBefore.jobsFailed24h >= 1);

  const finalized = await finalizeExhaustedBackupJobIfNeeded(
    stalledJobId,
    'Đứt kết nối SSH sau 10 lần thử lại'
  );
  assert.equal(finalized, true);

  const afterRow = db
    .prepare('SELECT status, completed_at, error_log FROM backup_jobs WHERE id = ?')
    .get(stalledJobId) as {
    status: string;
    completed_at: string | null;
    error_log: string | null;
  };
  assert.equal(afterRow.status, 'FAILED');
  assert.ok(afterRow.completed_at);
  assert.ok(afterRow.error_log?.includes('10 lần'));

  // N27: Cấm hủy tiến trình đã ở trạng thái kết thúc (FAILED / COMPLETED)
  assert.equal(cancelRunningOrQueuedJob(stalledJobId), false);

  // N21: Tài khoản MariaDB Sandbox cô lập riêng theo từng jobId và <= 32 ký tự
  const u1 = buildIsolatedSandboxVerifierUsername(101);
  const u2 = buildIsolatedSandboxVerifierUsername(102);
  assert.notEqual(u1, u2);
  assert.ok(u1.length <= 32 && u2.length <= 32);

  // N22: executeRestoreJob gặp lỗi tiền kiểm tra phải tự cập nhật trạng thái sang FAILED (không bị treo mãi ở RUNNING)
  const badRestoreRes = db
    .prepare(
      `INSERT INTO backup_jobs (job_type, server_id, target_server_id, snapshot_name, status, restore_options)
       VALUES ('RESTORE', ?, ?, '2026-11-03_01-00-00', 'QUEUED', '{invalid-json')`
    )
    .run(serverId, serverId);
  const badRestoreId = Number(badRestoreRes.lastInsertRowid);
  await assert.rejects(() => executeRestoreJob(badRestoreId));
  const badRestoreRow = db
    .prepare('SELECT status FROM backup_jobs WHERE id = ?')
    .get(badRestoreId) as { status: string };
  assert.equal(badRestoreRow.status, 'FAILED');

  // S14: Cờ rsync bắt buộc phải có --no-owner, --no-group và --chmod=ugo-s
  const rsyncArgs = buildRsyncPullArgs({
    server: {
      id: serverId,
      hostname: 'n18-vps.example.com',
      ip_address: '198.51.100.18',
      ssh_port: 22,
      ssh_user: 'root',
      ssh_key_path: '',
      panel_type: 'DIRECTADMIN',
      assigned_volume_id: null,
      bw_limit_kbps: 10240,
      status: 'ONLINE',
      is_mock: 1,
      last_connected_at: null,
      notes: '',
      host_key_status: 'VERIFIED',
      known_host_entry:
        '198.51.100.18 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti',
      created_at: new Date().toISOString(),
    },
    remoteWebroot: '/home/user1/domains/example.com/public_html',
    destPublicHtmlDir: path.join(tempVolDir, 'dest'),
  });
  assert.ok(rsyncArgs.includes('--no-owner'));
  assert.ok(rsyncArgs.includes('--no-group'));
  assert.ok(rsyncArgs.includes('--chmod=ugo-s'));
  assert.ok(!rsyncArgs.includes('--no-keep-dirlinks'));
  assert.ok(!rsyncArgs.includes('--keep-dirlinks'));
  assert.ok(!rsyncArgs.includes('-K'));

  const { buildRsyncRestoreArgs } = await import(
    '../src/lib/engine/restore-worker'
  );
  const { buildMailboxRsyncArgs } = await import(
    '../src/lib/engine/extended-hosting-backup'
  );
  const { isTransientSshTransportError } = await import('../src/lib/ssh');
  const mockSrv = {
    id: serverId,
    hostname: 'n18-vps.example.com',
    ip_address: '198.51.100.18',
    ssh_port: 22,
    ssh_user: 'root',
    ssh_key_path: '',
    panel_type: 'DIRECTADMIN' as const,
    assigned_volume_id: null,
    bw_limit_kbps: 10240,
    status: 'ONLINE' as const,
    is_mock: 1,
    last_connected_at: null,
    notes: '',
    host_key_status: 'VERIFIED' as const,
    known_host_entry:
      '198.51.100.18 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILM+rvN+ot98qgEN796jTiQfZfG1KaT0PtFDJ/XFSqti',
    created_at: new Date().toISOString(),
  };

  const restoreArgs = buildRsyncRestoreArgs({
    targetServer: mockSrv,
    targetUser: 'user1',
    localPublicHtmlDir: path.join(tempVolDir, 'src_restore'),
    targetWebroot: '/home/user1/domains/example.com/public_html',
  });
  const mailboxArgs = buildMailboxRsyncArgs({
    server: mockSrv,
    remoteMailboxDir: '/home/user1/imap/example.com',
    systemUser: 'user1',
    destMailboxDir: path.join(tempVolDir, 'dest_mail'),
    linkDestMailboxDir: null,
  });

  for (const argSet of [restoreArgs, mailboxArgs]) {
    assert.ok(argSet.includes('--no-owner'));
    assert.ok(argSet.includes('--no-group'));
    assert.ok(argSet.includes('--chmod=ugo-s'));
    assert.ok(!argSet.includes('--no-keep-dirlinks'));
    assert.ok(!argSet.includes('--keep-dirlinks'));
  }

  // Lỗi cú pháp lệnh rsync (code 1) tuyệt đối không được phân loại nhầm thành mất mạng SSH tạm thời (tránh retry 10 lần vô ích)
  assert.equal(
    isTransientSshTransportError(
      0,
      'Rsync thất bại (Mã lỗi 1): rsync: --no-keep-dirlinks: unknown option'
    ),
    false
  );
  assert.equal(
    isTransientSshTransportError(
      0,
      'kex_exchange_identification: read: Connection reset by peer'
    ),
    true
  );

  // Trên môi trường Linux có cài sẵn `rsync` (như CI ubuntu-latest / Alpine), chạy thử `rsync --dry-run` với toàn bộ cờ CLI
  const { spawnSync } = await import('node:child_process');
  const hasRsync = spawnSync('rsync', ['--version'], { stdio: 'ignore' });
  if (hasRsync.status === 0) {
    const localSrc = path.join(tempVolDir, 'rsync_cli_src');
    const localDst = path.join(tempVolDir, 'rsync_cli_dst');
    fs.mkdirSync(localSrc, { recursive: true });
    fs.mkdirSync(localDst, { recursive: true });
    fs.writeFileSync(path.join(localSrc, 'probe.txt'), 'ok', 'utf8');

    for (const fullArgs of [rsyncArgs, restoreArgs, mailboxArgs]) {
      const flagOnly = fullArgs.filter((a, idx) => {
        if (a === '-e' || fullArgs[idx - 1] === '-e') return false;
        if (a.startsWith('--rsync-path=')) return false;
        if (idx >= fullArgs.length - 2) return false;
        return true;
      });
      const dry = spawnSync(
        'rsync',
        ['--dry-run', ...flagOnly, `${localSrc}/`, `${localDst}/`],
        { encoding: 'utf8' }
      );
      assert.equal(
        dry.status,
        0,
        `rsync --dry-run thất bại với bộ cờ CLI: ${dry.stderr}`
      );
    }
  }
});

test('4. [Wave 5 & 7 — U6..U16] Khóa công khai Ed25519 dùng chung, ký số cả prebuilt + bundle, xác thực update.sh fail-closed, băm package-lock.json & chặn hạ cấp', async () => {
  const { verifyReleaseSignature } = await import(
    '../src/lib/release-signature'
  );
  const { BUNDLE_SIGNATURE_DOMAIN, PREBUILT_SIGNATURE_DOMAIN } = await import(
    '../src/lib/release-public-key.mjs'
  );
  const {
    assertNotDowngradeRelease,
    haveDependenciesChanged,
    isBaseImageRebuildRecommended,
  } = await import('../src/lib/updater');

  // U16 + U9: Ký số cả nas-sync-prebuilt.tar.gz và nas-sync-bundle.tar.gz bằng scripts/sign-release.mjs
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .trim();
  const privPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
    .trim();

  const signWorkRoot = fs.mkdtempSync(
    path.join(tempRoot, 'release-sign-test-')
  );
  const relDir = path.join(signWorkRoot, 'release');
  fs.mkdirSync(relDir, { recursive: true });
  const prebuiltBuf = Buffer.from('fake-prebuilt-tarball-v1.7.1', 'utf8');
  const bundleBuf = Buffer.from('fake-nas-bundle-tarball-v1.7.1', 'utf8');
  const prebuiltSha = crypto
    .createHash('sha256')
    .update(prebuiltBuf)
    .digest('hex');
  const bundleSha = crypto.createHash('sha256').update(bundleBuf).digest('hex');

  fs.writeFileSync(path.join(relDir, 'nas-sync-prebuilt.tar.gz'), prebuiltBuf);
  fs.writeFileSync(
    path.join(relDir, 'nas-sync-prebuilt.tar.gz.sha256'),
    `${prebuiltSha}  nas-sync-prebuilt.tar.gz\n`
  );
  fs.writeFileSync(path.join(relDir, 'nas-sync-bundle.tar.gz'), bundleBuf);
  fs.writeFileSync(
    path.join(relDir, 'nas-sync-bundle.tar.gz.sha256'),
    `${bundleSha}  nas-sync-bundle.tar.gz\n`
  );

  const signRun = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), 'scripts', 'sign-release.mjs'),
      '--tag',
      'v1.7.1',
    ],
    {
      cwd: signWorkRoot,
      env: {
        ...process.env,
        RELEASE_SIGNING_PRIVATE_KEY: privPem,
        NAS_SYNC_RELEASE_PUBLIC_KEY_PEM: pubPem,
      },
      encoding: 'utf8',
    }
  );
  assert.equal(
    signRun.status,
    0,
    `sign-release.mjs phải ký thành công cả 2 gói (stderr: ${signRun.stderr})`
  );

  const prebuiltSig = fs.readFileSync(
    path.join(relDir, 'nas-sync-prebuilt.tar.gz.sig'),
    'utf8'
  );
  const bundleSig = fs.readFileSync(
    path.join(relDir, 'nas-sync-bundle.tar.gz.sig'),
    'utf8'
  );
  assert.equal(
    verifyReleaseSignature(
      'v1.7.1',
      prebuiltSha,
      prebuiltSig,
      pubPem,
      PREBUILT_SIGNATURE_DOMAIN
    ),
    true
  );
  assert.equal(
    verifyReleaseSignature(
      'v1.7.1',
      bundleSha,
      bundleSig,
      pubPem,
      BUNDLE_SIGNATURE_DOMAIN
    ),
    true
  );
  assert.notEqual(
    PREBUILT_SIGNATURE_DOMAIN,
    BUNDLE_SIGNATURE_DOMAIN,
    'Domain ký số giữa gói prebuilt và gói bundle phải tách biệt'
  );

  // U9: Kiểm tra thực thi trực tiếp update.sh ở chế độ NAS_SYNC_UPDATE_VERIFY_ONLY=1 qua local HTTP server
  const bashBin = resolveBashBinary();
  if (bashBin) {
    let activeServeDir = relDir;
    const srv = http.createServer((req, res) => {
      const cleanName = path.basename(String(req.url || '').split('?')[0]);
      const full = path.join(activeServeDir, cleanName);
      if (cleanName && fs.existsSync(full) && fs.statSync(full).isFile()) {
        res.writeHead(200);
        res.end(fs.readFileSync(full));
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const updateWorkCwd = fs.mkdtempSync(path.join(tempRoot, 'update-cwd-'));

    const runAsyncSh = (
      envVars: NodeJS.ProcessEnv
    ): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          bashBin,
          [path.join(process.cwd(), 'update.sh')],
          {
            cwd: updateWorkCwd,
            env: envVars,
            windowsHide: true,
          }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) =>
          resolve({ status: code, stdout, stderr })
        );
      });

    try {
      const okVerify = await runAsyncSh({
        ...process.env,
        NAS_SYNC_UPDATE_VERIFY_ONLY: '1',
        NAS_SYNC_RELEASE_BASE_URL_OVERRIDE: baseUrl,
        NAS_SYNC_RELEASE_TAG_OVERRIDE: 'v1.7.1',
        NAS_SYNC_RELEASE_PUBLIC_KEY_PEM: pubPem,
      });
      assert.equal(
        okVerify.status,
        0,
        `update.sh phải chấp nhận gói có chữ ký Ed25519 hợp lệ (stderr: ${okVerify.stderr}, stdout: ${okVerify.stdout})`
      );

      const badDir = fs.mkdtempSync(path.join(tempRoot, 'bad-bundle-'));
      fs.cpSync(relDir, badDir, { recursive: true });
      fs.writeFileSync(
        path.join(badDir, 'nas-sync-bundle.tar.gz.sig'),
        Buffer.alloc(64, 7).toString('base64')
      );
      activeServeDir = badDir;

      const badVerify = await runAsyncSh({
        ...process.env,
        NAS_SYNC_UPDATE_VERIFY_ONLY: '1',
        NAS_SYNC_RELEASE_BASE_URL_OVERRIDE: baseUrl,
        NAS_SYNC_RELEASE_TAG_OVERRIDE: 'v1.7.1',
        NAS_SYNC_RELEASE_PUBLIC_KEY_PEM: pubPem,
      });
      assert.notEqual(
        badVerify.status,
        0,
        'update.sh bắt buộc phải từ chối fail-closed khi chữ ký Ed25519 giả mạo'
      );

      // v1.7.3: Giả lập hệ điều hành gốc của NAS cài sẵn bản node quá cũ (có sha256 nhưng chưa có Ed25519 crypto.verify -> trả mã 20) —
      // update.sh phải tự động chuyển tiếp sang openssl kế tiếp mà vẫn từ chối chữ ký giả.
      const hasUsableOpenssl =
        spawnSync(
          bashBin,
          [
            '-c',
            'command -v openssl >/dev/null 2>&1 && openssl pkeyutl -help 2>&1 | grep -q -- "-rawin"',
          ],
          { windowsHide: true }
        ).status === 0;

      if (hasUsableOpenssl) {
        const fakeOldBin = fs.mkdtempSync(
          path.join(tempRoot, 'fake-old-node-')
        );
        fs.writeFileSync(
          path.join(fakeOldBin, 'node'),
          '#!/bin/sh\nexit 20\n',
          { mode: 0o755 }
        );
        fs.writeFileSync(
          path.join(fakeOldBin, 'node.cmd'),
          '@echo off\r\nexit /b 20\r\n'
        );
        const existingPathVal =
          process.env.PATH || process.env.Path || '';
        const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
        for (const k of Object.keys(mergedEnv)) {
          if (k.toLowerCase() === 'path') {
            delete mergedEnv[k];
          }
        }
        mergedEnv.PATH = `${fakeOldBin}${path.delimiter}${existingPathVal}`;

        activeServeDir = relDir;
        const fallbackVerify = await runAsyncSh({
          ...mergedEnv,
          NAS_SYNC_UPDATE_VERIFY_ONLY: '1',
          NAS_SYNC_RELEASE_BASE_URL_OVERRIDE: baseUrl,
          NAS_SYNC_RELEASE_TAG_OVERRIDE: 'v1.7.1',
          NAS_SYNC_RELEASE_PUBLIC_KEY_PEM: pubPem,
        });
        assert.equal(
          fallbackVerify.status,
          0,
          `update.sh phải tự động chuyển tiếp sang bộ xác thực dự phòng khi node trên NAS quá cũ (stderr: ${fallbackVerify.stderr}, stdout: ${fallbackVerify.stdout})`
        );

        activeServeDir = badDir;
        const fallbackBadVerify = await runAsyncSh({
          ...mergedEnv,
          NAS_SYNC_UPDATE_VERIFY_ONLY: '1',
          NAS_SYNC_RELEASE_BASE_URL_OVERRIDE: baseUrl,
          NAS_SYNC_RELEASE_TAG_OVERRIDE: 'v1.7.1',
          NAS_SYNC_RELEASE_PUBLIC_KEY_PEM: pubPem,
        });
        assert.notEqual(
          fallbackBadVerify.status,
          0,
          'Khi chuyển tiếp sang bộ xác thực dự phòng, chữ ký giả mạo vẫn phải bị chặn fail-closed'
        );
      }
    } finally {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }

  // U10: Phát hiện thay đổi chỉ riêng trong package-lock.json
  const dirA = fs.mkdtempSync(path.join(tempRoot, 'deps-a-'));
  const dirB = fs.mkdtempSync(path.join(tempRoot, 'deps-b-'));
  const samePkg = JSON.stringify({ dependencies: { next: '15.2.4' } });
  const pkgPathA = path.join(dirA, 'package.json');
  const pkgPathB = path.join(dirB, 'package.json');
  fs.writeFileSync(pkgPathA, samePkg);
  fs.writeFileSync(pkgPathB, samePkg);
  fs.writeFileSync(path.join(dirA, 'package-lock.json'), '{"lock":"v1"}');
  fs.writeFileSync(path.join(dirB, 'package-lock.json'), '{"lock":"v2"}');
  assert.equal(haveDependenciesChanged(pkgPathA, pkgPathB), true);

  // U13: Chặn tấn công hạ cấp phiên bản (Downgrade Attack)
  assert.throws(() => assertNotDowngradeRelease('v1.6.0', '1.7.1'), /hạ cấp/);
  assert.doesNotThrow(() => assertNotDowngradeRelease('v1.7.1', '1.7.1'));
  assert.doesNotThrow(() => assertNotDowngradeRelease('v1.7.2', '1.7.1'));

  // U8: Phát hiện lệch mã băm docker-entrypoint.sh giữa container nền và bản phát hành mới
  const fakeAppRoot = fs.mkdtempSync(path.join(tempRoot, 'app-root-'));
  const fakeDataDir = fs.mkdtempSync(path.join(tempRoot, 'data-dir-'));
  const fakeLiveCurrent = path.join(fakeDataDir, 'live_release', 'current');
  fs.mkdirSync(fakeLiveCurrent, { recursive: true });
  fs.writeFileSync(
    path.join(fakeAppRoot, 'docker-entrypoint.sh'),
    '#!/bin/sh\necho v0\n'
  );
  fs.writeFileSync(
    path.join(fakeLiveCurrent, 'docker-entrypoint.sh'),
    '#!/bin/sh\necho v1\n'
  );
  assert.equal(
    isBaseImageRebuildRecommended(fakeAppRoot, fakeDataDir),
    true
  );

  // U6, U7, U11: Cổng kiểm định tĩnh cho release.yml, Dockerfile & package-release.mjs
  const releaseYml = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  assert.ok(releaseYml.includes('environment: release-signing'));
  assert.ok(releaseYml.includes('merge-base --is-ancestor'));
  assert.ok(releaseYml.includes('npm ci --ignore-scripts'));
  assert.ok(releaseYml.includes('attest-build-provenance@'));

  const dockerfile = fs.readFileSync(
    path.join(process.cwd(), 'Dockerfile'),
    'utf8'
  );
  assert.match(dockerfile, /npm\s+ci\b[^\n]*--ignore-scripts/);

  const pkgRelScript = fs.readFileSync(
    path.join(process.cwd(), 'scripts', 'package-release.mjs'),
    'utf8'
  );
  assert.equal(
    pkgRelScript.includes("path.join(stageDir, '.env')"),
    false,
    'package-release.mjs không được chép sẵn .env mẫu vào gói phát hành'
  );
});

test('5. [Wave 6 & 8 — A5, A11, A13, A14, O7, C1, S2, S10] Xóa triệt để khóa cũ trong DB, chống xóa khóa login-throttle, fail-closed .totp_secret, ghim IP chống DNS Rebinding & bắt buộc HTTPS cho WORM', async () => {
  const {
    getDb,
    migrateLegacyVolumeLabelsAndWormSettings,
    setSettings,
  } = await import('../src/lib/db');
  const {
    getLoginLockSeconds,
    recordLoginFailure,
    resetLoginThrottleForTests,
  } = await import('../src/lib/login-throttle');
  const {
    decryptTotpSecret,
    encryptTotpSecret,
    migrateLegacyV1TotpSecrets,
    resetTotpKeyCacheForTests,
  } = await import('../src/lib/totp');
  const {
    MIN_OFFSITE_PASSPHRASE_LENGTH,
    assertSafeS3EndpointUrl,
  } = await import('../src/lib/engine/offsite-cloud');
  const { buildSafeConfigWriteScript } = await import(
    '../src/lib/engine/config-rewriter'
  );
  const { validateWormEndpointUrl } = await import(
    '../src/lib/engine/worm-snapshot'
  );

  // A11: Dọn sạch các dòng cấu hình thế hệ cũ khỏi bảng system_settings
  const db = getDb();
  const legacyPrefix = ['d', 's', 'm_'].join('');
  setSettings({
    worm_migrated_v170: 'true',
    worm_purged_legacy_v171: 'false',
    [`${legacyPrefix}password`]: 'old-plaintext-secret',
    [`${legacyPrefix}api_url`]: 'https://192.168.1.99:5001',
  });
  migrateLegacyVolumeLabelsAndWormSettings(db);
  const leftoverRow = db
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(`${legacyPrefix}password`);
  assert.equal(
    leftoverRow,
    undefined,
    'Mật khẩu cấu hình cũ phải bị xóa hoàn toàn khỏi bảng system_settings'
  );

  // A13: Không thể trục xuất (evict) trạng thái khóa bằng 5.500 username rác + khóa tổng theo IP
  resetLoginThrottleForTests();
  for (let i = 0; i < 8; i++) {
    recordLoginFailure('198.51.100.77|admin');
  }
  assert.ok(getLoginLockSeconds('198.51.100.77|admin') > 0);
  for (let i = 0; i < 5500; i++) {
    recordLoginFailure(`203.0.113.${i % 250}|random_user_${i}`);
  }
  assert.ok(
    getLoginLockSeconds('198.51.100.77|admin') > 0,
    'Bản ghi đang bị khóa không được phép bị xóa khi bảng đạt giới hạn 5.000 mục'
  );

  for (let i = 0; i < 30; i++) {
    recordLoginFailure(`198.51.100.88|spray_user_${i}`);
  }
  assert.ok(
    getLoginLockSeconds('198.51.100.88|brand_new_account') > 0,
    'Một IP gửi sai liên tiếp 30 lần phải bị khóa ở cấp IP'
  );
  resetLoginThrottleForTests();

  // A5: Tự động chuyển đổi khóa 2FA v1: sang v2: khi khởi động
  const sampleBase32 = 'JBSWY3DPEHPK3PXP';
  const v1Key = crypto
    .createHash('sha256')
    .update('nas-sync-totp:' + process.env.JWT_SECRET)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', v1Key, iv);
  const enc = Buffer.concat([
    cipher.update(sampleBase32, 'utf8'),
    cipher.final(),
  ]);
  const legacyV1Payload = `v1:${iv.toString('hex')}:${cipher
    .getAuthTag()
    .toString('hex')}:${enc.toString('hex')}`;

  const uRes = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, totp_secret, totp_enabled)
       VALUES ('v1_totp_admin', 'salt:hash', 'ADMIN', ?, 1)`
    )
    .run(legacyV1Payload);
  const migratedCnt = migrateLegacyV1TotpSecrets(db);
  assert.equal(migratedCnt, 1);
  const migratedRow = db
    .prepare('SELECT totp_secret FROM users WHERE id = ?')
    .get(Number(uRes.lastInsertRowid)) as { totp_secret: string };
  assert.ok(migratedRow.totp_secret.startsWith('v2:'));
  assert.equal(decryptTotpSecret(migratedRow.totp_secret), sampleBase32);

  // A14: Tệp .totp_secret bị hỏng (< 32 ký tự) bắt buộc fail-closed (không tự ghi đè làm mất 2FA)
  const brokenDataDir = fs.mkdtempSync(path.join(tempRoot, 'broken-totp-'));
  fs.writeFileSync(path.join(brokenDataDir, '.totp_secret'), 'corrupt-short\n');
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = brokenDataDir;
  resetTotpKeyCacheForTests();
  try {
    assert.throws(() => encryptTotpSecret(sampleBase32), /\[SECURITY\]/);
    assert.equal(
      fs.readFileSync(path.join(brokenDataDir, '.totp_secret'), 'utf8').trim(),
      'corrupt-short',
      'Không được tự ý ghi đè tệp .totp_secret bị lỗi'
    );
  } finally {
    process.env.DATA_DIR = prevDataDir;
    resetTotpKeyCacheForTests();
  }

  // O7 + C1: Ghim cứng IP công cộng hợp lệ cho S3 & từ chối IP nội bộ / mật khẩu Offsite >= 12 ký tự
  assert.equal(MIN_OFFSITE_PASSPHRASE_LENGTH, 12);
  const pinned = await assertSafeS3EndpointUrl(
    new URL('https://s3.example.com/bucket'),
    async () => [{ address: '93.184.216.34' }]
  );
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
  await assert.rejects(
    () =>
      assertSafeS3EndpointUrl(
        new URL('https://rebind.example.com/bucket'),
        async () => [{ address: '169.254.169.254' }]
      ),
    /\[SECURITY\]/
  );

  // S2: config-rewriter cấm fallback chạy dưới quyền root & dùng mv -fT
  const cfgWriteScript = buildSafeConfigWriteScript(
    '/home/client1/domains/example.com/public_html',
    'wp-config.php',
    'client1'
  );
  assert.ok(cfgWriteScript.includes('ERR_UNSAFE_SITE_USER'));
  assert.ok(cfgWriteScript.includes('exit 93'));
  assert.ok(cfgWriteScript.includes('mv -fT'));

  // S10: Mặc định từ chối HTTP không mã hóa ra mạng LAN cho dịch vụ WORM, cho phép HTTPS và loopback
  setSettings({ worm_tls_insecure: 'false' });
  assert.throws(
    () => validateWormEndpointUrl('http://192.168.1.50:5000', 'WORM Test'),
    /HTTPS/
  );
  assert.doesNotThrow(() =>
    validateWormEndpointUrl('https://192.168.1.50:5001', 'WORM Test')
  );
  assert.doesNotThrow(() =>
    validateWormEndpointUrl('http://127.0.0.1:18080', 'WORM Loopback Test')
  );
});

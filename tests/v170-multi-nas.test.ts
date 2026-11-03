import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tempRootDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nas-sync-v170-multinas-test-')
);
const tempVolDir = path.join(tempRootDir, 'vol1');
fs.mkdirSync(tempVolDir, { recursive: true });

process.env.DATA_DIR = tempRootDir;
process.env.SSH_KEYS_DIR = path.join(tempRootDir, 'ssh_keys');
process.env.STORAGE_VOLUMES = tempVolDir;
process.env.VOLUME_MIN_FREE_GB = '0';
process.env.VOLUME_MAX_USAGE_PERCENT = '99';
process.env.JWT_SECRET =
  'unit-test-v170-jwt-secret-key-at-least-32-chars-long-2026';
process.env.TOTP_ENCRYPTION_KEY =
  'unit-test-v170-dedicated-totp-secret-key-2026-strong';
process.env.NAS_SYNC_SKIP_BOOTSTRAP = 'true';

after(async () => {
  try {
    const { getDb } = await import('../src/lib/db');
    getDb().close();
  } catch {
    // Ignore teardown close errors
  }
  fs.rmSync(tempRootDir, { recursive: true, force: true });
});

function startJsonMockServer(
  handler: (
    req: http.IncomingMessage,
    bodyText: string,
    res: http.ServerResponse
  ) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        handler(req, Buffer.concat(chunks).toString('utf8'), res);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

test('1. [v1.7.0 FS Probe] Nhận diện chuẩn /proc/mounts đa hãng NAS & kiểm định nguyên tử POSIX Hard-Link / Symlink không để lại rác', async () => {
  const { parseProcMountsFsType, probeVolumeCapabilities } = await import(
    '../src/lib/engine/volume-manager'
  );

  const sampleProcMounts = [
    'overlay / overlay rw,relatime 0 0',
    'tank/vps_backups /mnt/truenas zfs rw,noatime,xattr,posixacl 0 0',
    '/dev/mapper/cachedev1 /mnt/qnap ext4 rw,noatime 0 0',
    '/dev/md2 /mnt/ugreen btrfs rw,relatime,ssd,space_cache=v2 0 0',
    'shfs /mnt/unraid_user fuse.shfs rw,nosuid,nodev 0 0',
    '/dev/nvme0n1p1 /mnt/unraid_cache xfs rw,noatime 0 0',
    '/dev/sdb1 /mnt/usb\\040backup exfat rw,relatime 0 0',
  ].join('\n');

  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/truenas/server01'),
    'zfs'
  );
  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/qnap/backups'),
    'ext4'
  );
  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/ugreen/vps'),
    'btrfs'
  );
  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/unraid_user/vps'),
    'fuse.shfs'
  );
  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/unraid_cache/vps'),
    'xfs'
  );
  assert.equal(
    parseProcMountsFsType(sampleProcMounts, '/mnt/usb backup/daily'),
    'exfat'
  );

  const caps = await probeVolumeCapabilities(tempVolDir, true);
  assert.equal(caps.writable, true);
  assert.equal(caps.hardlink_supported, true);
  assert.equal(caps.symlink_supported, true);
  assert.equal(
    fs.existsSync(path.join(tempVolDir, '.nas-sync-probe')),
    false,
    'Thư mục .nas-sync-probe phải được dọn sạch hoàn toàn sau khi kiểm định'
  );
});

test('2. [v1.7.0 Universal WORM] Hỗ trợ đầy đủ TrueNAS ZFS Hold API v2.0, Custom Webhook HMAC-SHA256 & NAS Btrfs Share WebAPI', async () => {
  const { setSettings } = await import('../src/lib/db');
  const { triggerImmutableWormSnapshot } = await import(
    '../src/lib/engine/worm-snapshot'
  );

  // 2A. Chế độ mặc định NONE
  setSettings({
    worm_provider: 'NONE',
    worm_target_shares: 'tank/vps_backups',
    worm_retention_days: '7',
  });
  const noneRes = await triggerImmutableWormSnapshot(7);
  assert.equal(noneRes.ok, true);
  assert.equal(noneRes.provider, 'NONE');
  assert.equal(noneRes.simulated, true);

  // 2B. TrueNAS SCALE ZFS Snapshot + Kernel Hold + Tự động giải phóng bản chụp quá hạn
  const zfsCalls: Array<{ method: string; url: string; auth: string; body: string }> =
    [];
  const truenasMock = await startJsonMockServer((req, body, res) => {
    zfsCalls.push({
      method: req.method || '',
      url: req.url || '',
      auth: String(req.headers.authorization || ''),
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url?.startsWith('/api/v2.0/zfs/snapshot?')) {
      res.end(
        JSON.stringify([
          {
            id: 'tank/vps_backups@nas-sync-worm-2020-01-01_00-00-00',
            snapshot_name: 'nas-sync-worm-2020-01-01_00-00-00',
          },
          {
            id: 'tank/vps_backups@manual-keep-forever',
            snapshot_name: 'manual-keep-forever',
          },
        ])
      );
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    setSettings({
      worm_provider: 'TRUENAS_ZFS',
      worm_api_url: truenasMock.url,
      worm_api_key: '1-truenas-secret-api-token',
      worm_target_shares: 'tank/vps_backups',
      worm_retention_days: '7',
    });

    const zfsRes = await triggerImmutableWormSnapshot(7);
    assert.equal(zfsRes.ok, true);
    assert.equal(zfsRes.provider, 'TRUENAS_ZFS');
    assert.deepEqual(zfsRes.targetsProcessed, ['tank/vps_backups']);
    assert.equal(zfsRes.expiredReleased, 1);

    assert.ok(
      zfsCalls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/v2.0/zfs/snapshot' &&
          c.auth === 'Bearer 1-truenas-secret-api-token'
      ),
      'Phải gọi tạo ZFS Snapshot với Bearer Token'
    );
    assert.ok(
      zfsCalls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/v2.0/zfs/snapshot/hold' &&
          c.body.includes('tank/vps_backups@nas-sync-worm-')
      ),
      'Phải khóa cứng ZFS Hold trên bản chụp mới'
    );
    assert.ok(
      zfsCalls.some(
        (c) =>
          c.method === 'POST' &&
          c.url === '/api/v2.0/zfs/snapshot/release' &&
          c.body.includes('nas-sync-worm-2020-01-01_00-00-00')
      ),
      'Phải tự động gỡ khóa hold của bản chụp NAS-Sync quá hạn'
    );

    // Chặn Dataset không hợp lệ (chống Path Traversal / Injection)
    setSettings({
      worm_target_shares: 'tank/../bad;id',
    });
    const badDatasetRes = await triggerImmutableWormSnapshot(7);
    assert.equal(badDatasetRes.ok, false);
  } finally {
    await truenasMock.close();
  }

  // 2C. Custom Host Webhook ký số HMAC-SHA256
  let receivedWebhookSig = '';
  let receivedWebhookTs = '';
  let receivedWebhookBody = '';
  const webhookSecret = 'super-secret-host-agent-hmac-key';

  const webhookMock = await startJsonMockServer((req, body, res) => {
    receivedWebhookSig = String(req.headers['x-nassync-signature'] || '');
    receivedWebhookTs = String(req.headers['x-nassync-timestamp'] || '');
    receivedWebhookBody = body;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'locked' }));
  });

  try {
    setSettings({
      worm_provider: 'WEBHOOK',
      worm_api_url: `${webhookMock.url}/hooks/worm`,
      worm_webhook_secret: webhookSecret,
      worm_target_shares: 'qnap_zfs_pool/backups',
    });
    const whRes = await triggerImmutableWormSnapshot(14);
    assert.equal(whRes.ok, true);
    assert.equal(whRes.provider, 'WEBHOOK');
    const expectedHmac = crypto
      .createHmac('sha256', webhookSecret)
      .update(`${receivedWebhookTs}.${receivedWebhookBody}`)
      .digest('hex');
    assert.equal(receivedWebhookSig, `sha256=${expectedHmac}`);
  } finally {
    await webhookMock.close();
  }

  // 2D. NAS Btrfs Share Snapshot WebAPI (login -> create immutable -> logout)
  const webApiSteps: string[] = [];
  const webApiMock = await startJsonMockServer((req, body, res) => {
    const params = new URLSearchParams(body);
    const method = params.get('method') || '';
    webApiSteps.push(`${req.url}:${method}`);
    res.setHeader('Content-Type', 'application/json');
    if (method === 'login') {
      res.end(JSON.stringify({ success: true, data: { sid: 'mock-sid-999' } }));
      return;
    }
    if (method === 'create') {
      assert.equal(params.get('is_locked'), 'true');
      assert.equal(params.get('immutable'), 'true');
      assert.equal(params.get('immutable_days'), '10');
      assert.equal(params.get('_sid'), 'mock-sid-999');
      res.end(JSON.stringify({ success: true }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });

  try {
    setSettings({
      worm_provider: 'NAS_WEBAPI',
      worm_api_url: webApiMock.url,
      worm_username: 'nasadmin',
      worm_password: 'naspassword123',
      worm_target_shares: 'VPS_Backups',
    });
    const webRes = await triggerImmutableWormSnapshot(10);
    assert.equal(webRes.ok, true);
    assert.equal(webRes.provider, 'NAS_WEBAPI');
    assert.deepEqual(webApiSteps, [
      '/webapi/auth.cgi:login',
      '/webapi/entry.cgi:create',
      '/webapi/auth.cgi:logout',
    ]);
  } finally {
    await webApiMock.close();
  }
});

test('3. [v1.7.0 DB Migration & Vendor-Neutral Gate] Tự động nâng cấp nhãn Volume/WORM cũ & toàn bộ hệ thống không còn định danh hãng đơn lẻ', async () => {
  const {
    getDb,
    getSetting,
    migrateLegacyVolumeLabelsAndWormSettings,
    setSettings,
  } = await import('../src/lib/db');

  const db = getDb();
  const legacyBrandWord = ['Syno', 'logy'].join('');
  const legacyDsmPrefix = ['d', 's', 'm_'].join('');

  db.prepare('UPDATE storage_volumes SET name = ? WHERE priority = 1').run(
    `${legacyBrandWord} Volume 1`
  );
  setSettings({
    worm_migrated_v170: 'false',
    worm_provider: 'NONE',
    worm_api_url: '',
    worm_username: '',
    worm_password: '',
    worm_target_shares: 'VPS_Backups',
    worm_tls_insecure: 'false',
    [`${legacyDsmPrefix}api_url`]: 'https://192.168.1.200:5001',
    [`${legacyDsmPrefix}username`]: 'legacy_admin',
    [`${legacyDsmPrefix}password`]: 'legacy_secret',
    [`${legacyDsmPrefix}backup_shares`]: 'Legacy_Share_A,Legacy_Share_B',
    [`${legacyDsmPrefix}tls_insecure`]: 'true',
  });

  migrateLegacyVolumeLabelsAndWormSettings(db);

  const volRow = db
    .prepare('SELECT name FROM storage_volumes WHERE priority = 1')
    .get() as { name: string };
  assert.equal(volRow.name, 'NAS Volume 1');
  assert.equal(getSetting('worm_provider'), 'NAS_WEBAPI');
  assert.equal(getSetting('worm_api_url'), 'https://192.168.1.200:5001');
  assert.equal(getSetting('worm_username'), 'legacy_admin');
  assert.equal(getSetting('worm_password'), 'legacy_secret');
  assert.equal(
    getSetting('worm_target_shares'),
    'Legacy_Share_A,Legacy_Share_B'
  );
  assert.equal(getSetting('worm_tls_insecure'), 'true');

  // Cổng kiểm định tự động: toàn bộ mã nguồn, giao diện, kịch bản cài đặt & README sạch 100% định danh hãng đơn lẻ
  const repoRoot = process.cwd();
  const vendorRegex = new RegExp(legacyBrandWord, 'i');
  const checkTargets = [
    'src',
    'public',
    'scripts',
    '.github',
    'Dockerfile',
    'docker-compose.yml',
    'docker-entrypoint.sh',
    '.env.example',
    '.gitattributes',
    'package.json',
    'install.sh',
    'update.sh',
    'README.md',
    'HUONG-DAN-CAI-DAT-NAS.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
  ];

  const violations: string[] = [];
  function scanTarget(relPath: string) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) return;
    const st = fs.statSync(absPath);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(absPath)) {
        scanTarget(path.join(relPath, entry));
      }
      return;
    }
    if (vendorRegex.test(relPath)) {
      violations.push(`FILENAME: ${relPath}`);
    }
    const content = fs.readFileSync(absPath, 'utf8');
    content.split(/\r?\n/).forEach((line, idx) => {
      if (vendorRegex.test(line)) {
        violations.push(`${relPath}:${idx + 1}: ${line.trim()}`);
      }
    });
  }

  for (const t of checkTargets) {
    scanTarget(t);
  }

  assert.deepEqual(
    violations,
    [],
    `Phát hiện chuỗi định danh hãng đơn lẻ còn sót lại:\n${violations.join('\n')}`
  );
});

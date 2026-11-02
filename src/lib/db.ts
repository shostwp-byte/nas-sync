import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from './password';

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __nasSyncDb: SqliteDatabase | undefined;
}

export function getDataDir(): string {
  const dir = process.env.DATA_DIR || path.resolve(process.cwd(), 'app_data');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSshKeysDir(): string {
  const dir = process.env.SSH_KEYS_DIR || path.resolve(process.cwd(), 'ssh_keys');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDbFilePath(): string {
  const dir = getDataDir();
  const preferred = path.join(dir, 'nas-sync.db');
  if (fs.existsSync(preferred)) {
    return preferred;
  }

  // Tự động phát hiện và chuẩn hóa tên file CSDL thế hệ cũ (nếu có) sang nas-sync.db
  try {
    const legacyFile = fs
      .readdirSync(dir)
      .find(
        (f) =>
          f.endsWith('.db') &&
          !f.startsWith('nas-sync') &&
          !f.includes('.bak')
      );
    if (legacyFile) {
      const legacyPath = path.join(dir, legacyFile);
      try {
        for (const ext of ['', '-wal', '-shm']) {
          if (fs.existsSync(legacyPath + ext)) {
            fs.renameSync(legacyPath + ext, preferred + ext);
          }
        }
        return preferred;
      } catch {
        return legacyPath;
      }
    }
  } catch {
    // Bỏ qua nếu chưa đọc được thư mục
  }

  return preferred;
}

export function getDb(): SqliteDatabase {
  if (globalThis.__nasSyncDb) {
    return globalThis.__nasSyncDb;
  }

  const sqliteModule = (
    process as unknown as {
      getBuiltinModule: (name: string) => {
        DatabaseSync: new (filename: string) => SqliteDatabase;
      };
    }
  ).getBuiltinModule('node:sqlite');

  const dbPath = getDbFilePath();
  const db = new sqliteModule.DatabaseSync(dbPath);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  initializeSchema(db);
  seedDefaults(db);

  globalThis.__nasSyncDb = db;
  return db;
}

export function resetDbConnectionForTests(): void {
  if (globalThis.__nasSyncDb) {
    try {
      globalThis.__nasSyncDb.close();
    } catch {
      // Ignore close errors in test teardown
    }
    globalThis.__nasSyncDb = undefined;
  }
}

function initializeSchema(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ADMIN',
      token_version INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_pending_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      recovery_codes_json TEXT NOT NULL DEFAULT '[]',
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT 'SYSTEM',
      resource_id TEXT,
      detail TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS storage_volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mount_path TEXT NOT NULL UNIQUE,
      max_usage_percent INTEGER NOT NULL DEFAULT 85,
      min_free_gb INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      priority INTEGER NOT NULL DEFAULT 1,
      btrfs_immutable_enabled INTEGER NOT NULL DEFAULT 0,
      btrfs_retention_days INTEGER NOT NULL DEFAULT 7,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      used_bytes INTEGER NOT NULL DEFAULT 0,
      free_bytes INTEGER NOT NULL DEFAULT 0,
      last_checked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT 'ed25519',
      private_key_path TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname TEXT NOT NULL UNIQUE,
      ip_address TEXT NOT NULL,
      ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_user TEXT NOT NULL DEFAULT 'root',
      ssh_key_path TEXT NOT NULL DEFAULT '',
      panel_type TEXT NOT NULL DEFAULT 'DIRECTADMIN',
      assigned_volume_id INTEGER REFERENCES storage_volumes(id) ON DELETE SET NULL,
      bw_limit_kbps INTEGER NOT NULL DEFAULT 25600,
      status TEXT NOT NULL DEFAULT 'ONLINE',
      is_mock INTEGER NOT NULL DEFAULT 0,
      last_connected_at TEXT,
      notes TEXT NOT NULL DEFAULT '',
      custom_excludes TEXT NOT NULL DEFAULT '',
      backup_mailboxes INTEGER NOT NULL DEFAULT 0,
      backup_cronjobs INTEGER NOT NULL DEFAULT 0,
      backup_vhost_configs INTEGER NOT NULL DEFAULT 0,
      host_key_fingerprint TEXT NOT NULL DEFAULT '',
      known_host_entry TEXT NOT NULL DEFAULT '',
      host_key_status TEXT NOT NULL DEFAULT 'UNPINNED',
      host_key_pending_fingerprint TEXT NOT NULL DEFAULT '',
      host_key_pending_entry TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backup_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cron_expression TEXT NOT NULL DEFAULT '0 1 * * *',
      server_ids TEXT NOT NULL DEFAULT '[]',
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      retention_policy TEXT NOT NULL DEFAULT '{"daily":7,"weekly":4,"monthly":6}',
      verify_db_sandbox INTEGER NOT NULL DEFAULT 1,
      btrfs_snapshot_after INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL DEFAULT 'BACKUP',
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      target_server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      schedule_id INTEGER REFERENCES backup_schedules(id) ON DELETE SET NULL,
      volume_id INTEGER REFERENCES storage_volumes(id) ON DELETE SET NULL,
      snapshot_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'QUEUED',
      progress_percent INTEGER NOT NULL DEFAULT 0,
      current_phase TEXT NOT NULL DEFAULT 'Đang chờ hàng đợi...',
      current_domain TEXT NOT NULL DEFAULT '',
      speed_bps INTEGER NOT NULL DEFAULT 0,
      eta_seconds INTEGER NOT NULL DEFAULT 0,
      total_size_bytes INTEGER NOT NULL DEFAULT 0,
      delta_size_bytes INTEGER NOT NULL DEFAULT 0,
      files_total INTEGER NOT NULL DEFAULT 0,
      files_changed INTEGER NOT NULL DEFAULT 0,
      anomaly_detected INTEGER NOT NULL DEFAULT 0,
      anomaly_reason TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      restore_options TEXT,
      started_at TEXT,
      completed_at TEXT,
      error_log TEXT,
      live_log TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backup_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      volume_id INTEGER NOT NULL REFERENCES storage_volumes(id) ON DELETE CASCADE,
      snapshot_name TEXT NOT NULL,
      system_user TEXT NOT NULL,
      domain_name TEXT NOT NULL,
      source_webroot TEXT NOT NULL DEFAULT '',
      webroot_backed_up INTEGER NOT NULL DEFAULT 0,
      webroot_size_bytes INTEGER NOT NULL DEFAULT 0,
      databases_list TEXT NOT NULL DEFAULT '[]',
      php_version TEXT NOT NULL DEFAULT '8.2',
      is_subdomain INTEGER NOT NULL DEFAULT 0,
      parent_domain TEXT,
      verification_status TEXT NOT NULL DEFAULT 'UNTESTED',
      verification_detail TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      severity TEXT NOT NULL DEFAULT 'INFO',
      category TEXT NOT NULL DEFAULT 'SYSTEM',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      server_id INTEGER,
      job_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS storage_daily_stats (
      stat_date TEXT PRIMARY KEY,
      logical_bytes INTEGER NOT NULL DEFAULT 0,
      physical_delta_bytes INTEGER NOT NULL DEFAULT 0,
      volumes_used_bytes INTEGER NOT NULL DEFAULT 0,
      volumes_total_bytes INTEGER NOT NULL DEFAULT 0,
      completed_jobs_count INTEGER NOT NULL DEFAULT 0,
      failed_jobs_count INTEGER NOT NULL DEFAULT 0,
      verified_dbs_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS offsite_sync_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_job_id INTEGER NOT NULL REFERENCES backup_jobs(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      snapshot_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      remote_object_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'QUEUED',
      encrypted_size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_server_status ON backup_jobs(server_id, status);
    CREATE INDEX IF NOT EXISTS idx_items_job ON backup_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_items_server_domain ON backup_items(server_id, domain_name);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON system_alerts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_offsite_created ON offsite_sync_jobs(created_at DESC, id DESC);
  `);

  // Tự động nâng cấp lược đồ CSDL an toàn cho các bản cài đặt từ v1.0.0 / v1.1.x / v1.2.x
  try {
    const userCols = new Set(
      db
        .prepare('PRAGMA table_info(users)')
        .all()
        .map((col) => String(col.name))
    );
    const userColumnMigrations: Array<[string, string]> = [
      ['token_version', 'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1'],
      ['totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret TEXT'],
      ['totp_pending_secret', 'ALTER TABLE users ADD COLUMN totp_pending_secret TEXT'],
      ['totp_enabled', 'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0'],
      [
        'recovery_codes_json',
        "ALTER TABLE users ADD COLUMN recovery_codes_json TEXT NOT NULL DEFAULT '[]'",
      ],
    ];
    for (const [colName, alterSql] of userColumnMigrations) {
      if (!userCols.has(colName)) {
        db.exec(alterSql);
      }
    }
  } catch {
    // Bỏ qua nếu cột đã tồn tại
  }

  const migrations = [
    `ALTER TABLE backup_items ADD COLUMN is_subdomain INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE backup_items ADD COLUMN parent_domain TEXT`,
    `ALTER TABLE servers ADD COLUMN custom_excludes TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN backup_mailboxes INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN backup_cronjobs INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN backup_vhost_configs INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE servers ADD COLUMN host_key_fingerprint TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN known_host_entry TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN host_key_status TEXT NOT NULL DEFAULT 'UNPINNED'`,
    `ALTER TABLE servers ADD COLUMN host_key_pending_fingerprint TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE servers ADD COLUMN host_key_pending_entry TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Cột đã tồn tại
    }
  }

  // Nâng cấp v1.4.0: Đảm bảo các máy chủ Demo mô phỏng (is_mock = 1) có sẵn khóa TOFU mẫu
  try {
    db.prepare(
      `UPDATE servers
       SET host_key_status = 'VERIFIED',
           host_key_fingerprint = 'SHA256:MockEd25519HostKeyPinningDemoV140'
       WHERE is_mock = 1 AND (host_key_fingerprint = '' OR host_key_status = 'UNPINNED')`
    ).run();
  } catch {
    // Bỏ qua nếu bảng chưa sẵn sàng
  }

  // Nâng cấp v1.1.2: Hạ ngưỡng min_free_gb mặc định cũ (200 GB) xuống 10 GB để tránh báo FULL sai trên ổ cứng / Quota < 2TB
  try {
    const migFlag = db
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get('migrated_volume_min_free_v112');
    if (!migFlag) {
      db.prepare(
        `UPDATE storage_volumes
         SET min_free_gb = 10,
             status = CASE WHEN status = 'FULL' THEN 'ACTIVE' ELSE status END
         WHERE min_free_gb = 200`
      ).run();
      db.prepare(
        `INSERT OR REPLACE INTO system_settings (key, value, updated_at)
         VALUES ('migrated_volume_min_free_v112', 'true', datetime('now'))`
      ).run();
    }
  } catch {
    // Bỏ qua nếu bảng chưa sẵn sàng
  }
}

function seedDefaults(db: SqliteDatabase) {
  // 1. Seed Admin User (hỗ trợ đặt lại mật khẩu / 2FA khẩn cấp qua biến môi trường FORCE_RESET_ADMIN_PASSWORD=true & FORCE_RESET_ADMIN_2FA=true)
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'nas-sync@2026';
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt as number;
  if (!userCount) {
    db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(adminUser, hashPassword(adminPass), 'ADMIN');
  } else {
    const firstAdmin = db
      .prepare("SELECT id FROM users WHERE role = 'ADMIN' ORDER BY id ASC LIMIT 1")
      .get();
    if (firstAdmin) {
      const targetAdminId = Number(firstAdmin.id);
      if (process.env.FORCE_RESET_ADMIN_PASSWORD === 'true' && process.env.ADMIN_PASSWORD) {
        db.prepare(
          'UPDATE users SET username = ?, password_hash = ?, token_version = COALESCE(token_version, 1) + 1 WHERE id = ?'
        ).run(adminUser, hashPassword(process.env.ADMIN_PASSWORD), targetAdminId);
      }
      if (process.env.FORCE_RESET_ADMIN_2FA === 'true') {
        db.prepare(
          `UPDATE users
           SET totp_enabled = 0,
               totp_secret = NULL,
               totp_pending_secret = NULL,
               recovery_codes_json = '[]',
               token_version = COALESCE(token_version, 1) + 1
           WHERE id = ?`
        ).run(targetAdminId);
      }
    }
  }

  // 2. Seed Storage Volumes
  const volCount = db
    .prepare('SELECT COUNT(*) as cnt FROM storage_volumes')
    .get()?.cnt as number;
  if (!volCount) {
    const isWindows = process.platform === 'win32';
    const maxPct = Number(process.env.VOLUME_MAX_USAGE_PERCENT || 85);
    const parsedMinFree = Number(process.env.VOLUME_MIN_FREE_GB ?? 10);
    const minFreeGb =
      Number.isFinite(parsedMinFree) && parsedMinFree >= 0 ? parsedMinFree : 10;

    const rawVolumes = process.env.STORAGE_VOLUMES
      ? process.env.STORAGE_VOLUMES.split(',').map((s) => s.trim()).filter(Boolean)
      : isWindows
      ? [
          path.join(getDataDir(), 'volumes', 'vol1'),
          path.join(getDataDir(), 'volumes', 'vol2'),
        ]
      : ['/mnt/vol1', '/mnt/vol2'];

    rawVolumes.forEach((mountPath, idx) => {
      try {
        if (!fs.existsSync(mountPath)) {
          fs.mkdirSync(mountPath, { recursive: true });
        }
      } catch {
        // Ignore if unmounted path in read-only env
      }
      db.prepare(
        `INSERT INTO storage_volumes (name, mount_path, max_usage_percent, min_free_gb, status, priority, btrfs_immutable_enabled, btrfs_retention_days)
         VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, 7)`
      ).run(
        `Synology Volume ${idx + 1}`,
        mountPath,
        maxPct,
        isWindows ? 5 : minFreeGb,
        idx + 1,
        idx === 0 ? 1 : 0
      );
    });
  }

  // 3. Seed Default System Settings
  const defaultSettings: Record<string, string> = {
    telegram_bot_token: process.env.TELEGRAM_BOT_TOKEN || '',
    telegram_chat_id: process.env.TELEGRAM_CHAT_ID || '',
    smtp_host: process.env.SMTP_HOST || '',
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    smtp_from: process.env.SMTP_FROM || 'noreply@example.com',
    alert_email_to: process.env.ALERT_EMAIL_TO || '',
    anomaly_max_changed_percent: '50',
    anomaly_max_delta_gb: '10',
    dsm_api_url: process.env.DSM_API_URL || '',
    dsm_username: process.env.DSM_USERNAME || '',
    dsm_password: process.env.DSM_PASSWORD || '',
    dsm_backup_shares: process.env.DSM_BACKUP_SHARES || 'VPS_Backups',
    btrfs_cron_time: '0 6 * * *',
    btrfs_auto_enabled: 'false',
    global_exclude_patterns: '',
    digest_enabled: 'false',
    digest_cron_time: '0 7 * * *',
    offsite_provider: 'NONE',
    offsite_auto_push: 'NONE',
    offsite_keep_count: '12',
    offsite_encryption_passphrase: '',
    offsite_s3_preset: 'R2',
    offsite_s3_endpoint: '',
    offsite_s3_region: 'auto',
    offsite_s3_bucket: '',
    offsite_s3_prefix: 'nas-sync',
    offsite_s3_access_key: '',
    offsite_s3_secret_key: '',
    offsite_gdrive_auth_mode: 'OAUTH2',
    offsite_gdrive_folder_id: '',
    offsite_gdrive_client_id: '',
    offsite_gdrive_client_secret: '',
    offsite_gdrive_refresh_token: '',
    offsite_gdrive_service_account_json: '',
  };

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)'
  );
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  // 4. Seed Demo Servers on Windows Local Dev (or when SEED_DEMO=true) if empty
  const serverCount = db
    .prepare('SELECT COUNT(*) as cnt FROM servers')
    .get()?.cnt as number;
  if (!serverCount && (process.platform === 'win32' || process.env.SEED_DEMO === 'true')) {
    const firstVol = db
      .prepare('SELECT id FROM storage_volumes ORDER BY priority ASC LIMIT 1')
      .get()?.id as number | undefined;

    const insServer = db.prepare(
      `INSERT INTO servers (hostname, ip_address, ssh_port, ssh_user, ssh_key_path, panel_type, assigned_volume_id, bw_limit_kbps, status, is_mock, notes, host_key_status, host_key_fingerprint)
       VALUES (?, ?, ?, 'root', '', ?, ?, ?, 'ONLINE', 1, ?, 'VERIFIED', 'SHA256:MockEd25519HostKeyPinningDemoV140')`
    );

    const s1 = insServer.run(
      'vps-da01.example.com',
      '103.221.220.101',
      2222,
      'DIRECTADMIN',
      firstVol ?? null,
      30720,
      'Máy chủ Hosting DirectAdmin mẫu (Chế độ Demo mô phỏng để chạy thử trên Windows)'
    );
    const s2 = insServer.run(
      'vps-cp02.example.com',
      '103.221.220.102',
      22,
      'CPANEL',
      firstVol ?? null,
      25600,
      'Máy chủ Hosting cPanel mẫu (Chế độ Demo mô phỏng)'
    );
    insServer.run(
      'vps-plesk03.example.com',
      '103.221.220.103',
      22,
      'PLESK',
      firstVol ?? null,
      25600,
      'Máy chủ Plesk Obsidian mẫu (Hỗ trợ test Cross-Panel Restore)'
    );
    insServer.run(
      'vps-aa04.example.com',
      '103.221.220.104',
      22,
      'AAPANEL',
      firstVol ?? null,
      20480,
      'Máy chủ aaPanel mẫu (Hỗ trợ test Cross-Panel Restore)'
    );

    db.prepare(
      `INSERT INTO backup_schedules (name, cron_expression, server_ids, max_concurrency, retention_policy, verify_db_sandbox, btrfs_snapshot_after, enabled)
       VALUES (?, '0 1 * * *', ?, 2, '{"daily":7,"weekly":4,"monthly":6}', 1, 1, 1)`
    ).run(
      'Sao lưu tự động ban đêm (01:00 AM - GFS)',
      JSON.stringify([Number(s1.lastInsertRowid), Number(s2.lastInsertRowid)])
    );
  }
}

export function getSetting(key: string, fallback = ''): string {
  const row = getDb()
    .prepare('SELECT value FROM system_settings WHERE key = ?')
    .get(key);
  return row ? String(row.value) : fallback;
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT key, value FROM system_settings')
    .all();
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[String(r.key)] = String(r.value);
  }
  return out;
}

export function setSettings(updates: Record<string, string>) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  for (const [k, v] of Object.entries(updates)) {
    stmt.run(k, v);
  }
}


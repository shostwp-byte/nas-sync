export type PanelType =
  | 'DIRECTADMIN'
  | 'CPANEL'
  | 'PLESK'
  | 'AAPANEL'
  | 'CYBERPANEL'
  | 'HESTIACP'
  | 'CLOUDPANEL';

export type DatabaseEngine = 'MYSQL' | 'POSTGRESQL';

export type OffsiteProviderType = 'NONE' | 'S3_COMPATIBLE' | 'GOOGLE_DRIVE';

export type OffsiteSyncStatus = 'QUEUED' | 'UPLOADING' | 'COMPLETED' | 'FAILED';

export type UserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

export type VolumeStatus = 'ACTIVE' | 'FULL' | 'MAINTENANCE';

export type ServerStatus = 'ONLINE' | 'OFFLINE' | 'BACKUP_RUNNING' | 'ERROR';

export type JobType = 'BACKUP' | 'RESTORE' | 'VERIFY' | 'RETENTION' | 'SEED_MIGRATION';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'INTERRUPTED'
  | 'RESUMING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type VerificationStatus = 'UNTESTED' | 'PASSED' | 'CORRUPTED';

export type RestoreMode = 'FILES_ONLY' | 'DB_ONLY' | 'FULL';

export interface StorageVolume {
  id: number;
  name: string;
  mount_path: string;
  max_usage_percent: number;
  min_free_gb: number;
  status: VolumeStatus;
  priority: number;
  btrfs_immutable_enabled: number;
  btrfs_retention_days: number;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  last_checked_at: string | null;
  created_at: string;
}

export interface SSHKeyRecord {
  id: number;
  name: string;
  key_type: string;
  private_key_path: string;
  public_key: string;
  fingerprint: string;
  created_at: string;
}

export type HostKeyStatus = 'UNPINNED' | 'VERIFIED' | 'MISMATCH';

export interface ServerRecord {
  id: number;
  hostname: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path: string;
  panel_type: PanelType;
  assigned_volume_id: number | null;
  assigned_volume_name?: string;
  assigned_volume_path?: string;
  bw_limit_kbps: number;
  status: ServerStatus;
  is_mock: number;
  last_connected_at: string | null;
  notes: string;
  custom_excludes?: string;
  backup_mailboxes?: number;
  backup_cronjobs?: number;
  backup_vhost_configs?: number;
  host_key_fingerprint?: string;
  known_host_entry?: string;
  host_key_status?: HostKeyStatus;
  host_key_pending_fingerprint?: string;
  host_key_pending_entry?: string;
  created_at: string;
}

export interface UserRecord {
  id: number;
  username: string;
  role: UserRole;
  totp_enabled: number;
  last_login_at: string | null;
  created_at: string;
}

export interface AuditLogRecord {
  id: number;
  user_id: number | null;
  username: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  detail: string;
  ip_address: string;
  created_at: string;
}

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupSchedule {
  id: number;
  name: string;
  cron_expression: string;
  server_ids: number[];
  max_concurrency: number;
  retention_policy: RetentionPolicy;
  verify_db_sandbox: boolean;
  btrfs_snapshot_after: boolean;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
}

export interface DatabaseBackupInfo {
  name: string;
  db_user?: string;
  engine?: DatabaseEngine;
  file: string;
  size_bytes: number;
  tables_count?: number;
  rows_count?: number;
  verified?: boolean;
  error?: string;
}

export interface BackupJob {
  id: number;
  job_type: JobType;
  server_id: number;
  server_hostname?: string;
  server_panel?: PanelType;
  target_server_id: number | null;
  target_server_hostname?: string;
  schedule_id: number | null;
  volume_id: number | null;
  volume_name?: string;
  volume_mount_path?: string;
  snapshot_name: string;
  status: JobStatus;
  progress_percent: number;
  current_phase: string;
  current_domain: string;
  speed_bps: number;
  eta_seconds: number;
  total_size_bytes: number;
  delta_size_bytes: number;
  files_total: number;
  files_changed: number;
  anomaly_detected: number;
  anomaly_reason: string | null;
  is_pinned: number;
  retry_count: number;
  restore_options?: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_log: string | null;
  live_log: string | null;
  created_at: string;
}

export interface BackupItem {
  id: number;
  job_id: number;
  server_id: number;
  volume_id: number;
  snapshot_name: string;
  system_user: string;
  domain_name: string;
  source_webroot: string;
  webroot_backed_up: number;
  webroot_size_bytes: number;
  databases_list: DatabaseBackupInfo[];
  php_version: string;
  is_subdomain?: number;
  parent_domain?: string | null;
  verification_status: VerificationStatus;
  verification_detail: string | null;
  is_pinned: number;
  created_at: string;
}

export interface DiscoveredDomain {
  domain: string;
  systemUser: string;
  webroot: string;
  phpVersion: string;
  isSubdomain?: boolean;
  parentDomain?: string;
  excludedSubpaths?: string[];
  databases: Array<{
    name: string;
    user?: string;
    engine?: DatabaseEngine;
  }>;
}

export interface MysqlAdminCredentials {
  user: string;
  defaultsFile?: string;
  socket?: string;
  remoteAuthPrelude?: string;
}

export interface DomainMetadataJson {
  panel_type: PanelType;
  hostname: string;
  domain_name: string;
  system_user: string;
  original_webroot: string;
  php_version: string;
  is_subdomain?: boolean;
  parent_domain?: string;
  excluded_subpaths?: string[];
  databases: Array<{
    name: string;
    user?: string;
    engine?: DatabaseEngine;
    dump_file: string;
    size_bytes: number;
  }>;
  snapshot_name: string;
  backed_up_at: string;
}

export interface InProgressState {
  jobId: number;
  snapshotName: string;
  startedAt: string;
  completedDomains: Record<
    string,
    {
      filesSynced: boolean;
      webrootSizeBytes: number;
      filesTotal: number;
      filesChanged: number;
      deltaBytes: number;
      completedDbs: Record<string, DatabaseBackupInfo>;
    }
  >;
}

export interface RestoreRequestPayload {
  sourceJobId: number;
  backupItemId: number;
  mode: RestoreMode;
  targetServerId: number;
  targetSystemUser?: string;
  targetDomainName?: string;
  targetWebrootOverride?: string;
  selectedDatabases?: string[];
  targetDbMap?: Record<string, string>;
  autoPatchConfig?: boolean;
}

export interface SystemAlert {
  id: number;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  category: 'VOLUME' | 'ANOMALY' | 'BACKUP' | 'RESTORE' | 'BTRFS' | 'SYSTEM';
  title: string;
  message: string;
  server_id: number | null;
  job_id: number | null;
  is_read: number;
  created_at: string;
}

export interface ProgressEventPayload {
  jobId: number;
  serverId: number;
  hostname: string;
  status: JobStatus;
  progressPercent: number;
  currentPhase: string;
  currentDomain: string;
  speedBps: number;
  etaSeconds: number;
  deltaSizeBytes: number;
  totalSizeBytes: number;
  retryCount: number;
}

export interface SystemUpdateInfo {
  repoUrl: string;
  currentVersion: string;
  currentCommit: string | null;
  latestVersion: string;
  latestCommit: string | null;
  latestPublishedAt: string | null;
  releaseTitle: string | null;
  changelog: string;
  hasUpdate: boolean;
  updateInProgress: boolean;
  canUpdateNow: boolean;
  blockingReason: string | null;
  prebuiltAvailable?: boolean;
  canRollback?: boolean;
  rollbackVersion?: string | null;
  rollbackUpdatedAt?: string | null;
  checkedAt: string;
}

export interface UpdateProgressEvent {
  status: 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'INSTALLING' | 'BUILDING' | 'RESTARTING' | 'COMPLETED' | 'FAILED';
  percent: number;
  message: string;
  logLine?: string;
  targetVersion?: string;
}

export interface StorageDailyStat {
  stat_date: string;
  logical_bytes: number;
  physical_delta_bytes: number;
  volumes_used_bytes: number;
  volumes_total_bytes: number;
  completed_jobs_count: number;
  failed_jobs_count: number;
  verified_dbs_count: number;
}

export interface TopDomainStat {
  domain_name: string;
  server_id: number;
  server_hostname: string;
  server_panel: PanelType;
  webroot_size_bytes: number;
  db_size_bytes: number;
  total_domain_bytes: number;
  databases_count: number;
  verification_status: VerificationStatus;
  snapshot_name: string;
}

export interface MorningDigestSummary {
  generatedAt: string;
  windowHours: number;
  totalServers: number;
  onlineServers: number;
  hostKeyMismatchCount: number;
  jobsSucceeded24h: number;
  jobsFailed24h: number;
  netDeltaBytes24h: number;
  totalLogicalBytes: number;
  totalPhysicalDeltaBytes: number;
  savingsPercent: number;
  verifiedDbs24h: number;
  corruptedDbs24h: number;
  anomalies24h: number;
  volumes: Array<{
    name: string;
    mount_path: string;
    used_bytes: number;
    free_bytes: number;
    total_bytes: number;
    status: VolumeStatus;
  }>;
}

export interface OffsiteSyncJob {
  id: number;
  backup_job_id: number;
  server_id: number;
  server_hostname?: string;
  snapshot_name: string;
  provider: OffsiteProviderType;
  remote_object_key: string;
  status: OffsiteSyncStatus;
  encrypted_size_bytes: number;
  duration_seconds: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export type PanelType = 'DIRECTADMIN' | 'CPANEL' | 'PLESK' | 'AAPANEL';

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
  }>;
}

export interface MysqlAdminCredentials {
  user: string;
  password?: string;
  defaultsFile?: string;
  socket?: string;
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
  checkedAt: string;
}

export interface UpdateProgressEvent {
  status: 'IDLE' | 'CHECKING' | 'DOWNLOADING' | 'INSTALLING' | 'BUILDING' | 'RESTARTING' | 'COMPLETED' | 'FAILED';
  percent: number;
  message: string;
  logLine?: string;
  targetVersion?: string;
}



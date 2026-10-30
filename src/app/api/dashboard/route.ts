import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getQueueRuntimeInfo } from '@/lib/engine/queue';
import { refreshAllVolumes } from '@/lib/engine/volume-manager';

export async function GET() {
  const db = getDb();
  const volumes = await refreshAllVolumes();

  const totalServers = Number(
    db.prepare('SELECT COUNT(*) AS c FROM servers').get()?.c || 0
  );
  const onlineServers = Number(
    db
      .prepare(`SELECT COUNT(*) AS c FROM servers WHERE status IN ('ONLINE', 'BACKUP_RUNNING')`)
      .get()?.c || 0
  );
  const totalSnapshots = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM backup_jobs WHERE job_type = 'BACKUP' AND status = 'COMPLETED'`
      )
      .get()?.c || 0
  );
  const activeJobsCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM backup_jobs WHERE status IN ('QUEUED', 'RUNNING', 'RESUMING', 'VERIFYING', 'INTERRUPTED')`
      )
      .get()?.c || 0
  );
  const verifiedItemsCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM backup_items WHERE verification_status = 'PASSED'`
      )
      .get()?.c || 0
  );
  const pinnedSnapshotsCount = Number(
    db.prepare(`SELECT COUNT(*) AS c FROM backup_jobs WHERE is_pinned = 1`).get()
      ?.c || 0
  );
  const anomalyCount = Number(
    db
      .prepare(`SELECT COUNT(*) AS c FROM backup_jobs WHERE anomaly_detected = 1`)
      .get()?.c || 0
  );

  const sizeAgg = db
    .prepare(
      `SELECT
         IFNULL(SUM(total_size_bytes), 0) AS logical_bytes,
         IFNULL(SUM(delta_size_bytes), 0) AS physical_delta_bytes
       FROM backup_jobs
       WHERE job_type = 'BACKUP' AND status = 'COMPLETED'`
    )
    .get();

  const logicalBytes = Number(sizeAgg?.logical_bytes || 0);
  const physicalDeltaBytes = Number(sizeAgg?.physical_delta_bytes || 0);
  const savingsPercent =
    logicalBytes > 0
      ? Math.max(0, ((logicalBytes - physicalDeltaBytes) / logicalBytes) * 100)
      : 0;

  const recentJobs = db
    .prepare(
      `SELECT
         j.*,
         s.hostname AS server_hostname,
         s.panel_type AS server_panel,
         ts.hostname AS target_server_hostname,
         v.name AS volume_name,
         v.mount_path AS volume_mount_path
       FROM backup_jobs j
       LEFT JOIN servers s ON s.id = j.server_id
       LEFT JOIN servers ts ON ts.id = j.target_server_id
       LEFT JOIN storage_volumes v ON v.id = j.volume_id
       ORDER BY j.id DESC
       LIMIT 12`
    )
    .all();

  const recentAlerts = db
    .prepare(`SELECT * FROM system_alerts ORDER BY id DESC LIMIT 10`)
    .all();

  const unreadAlertsCount = Number(
    db
      .prepare(`SELECT COUNT(*) AS c FROM system_alerts WHERE is_read = 0`)
      .get()?.c || 0
  );

  return NextResponse.json({
    stats: {
      totalServers,
      onlineServers,
      totalSnapshots,
      activeJobsCount,
      verifiedItemsCount,
      pinnedSnapshotsCount,
      anomalyCount,
      logicalBytes,
      physicalDeltaBytes,
      savingsPercent,
      unreadAlertsCount,
    },
    volumes,
    recentJobs,
    recentAlerts,
    runtime: getQueueRuntimeInfo(),
  });
}


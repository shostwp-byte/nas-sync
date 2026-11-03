import { getDb } from '@/lib/db';
import {
  type NotificationDispatchResult,
  sendDigestNotification,
} from '@/lib/notifications';
import type {
  DatabaseBackupInfo,
  MorningDigestSummary,
  PanelType,
  StorageDailyStat,
  TopDomainStat,
  VerificationStatus,
  VolumeStatus,
} from '@/types';
import { refreshAllVolumes } from './volume-manager';

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytesHuman(bytes: number): string {
  const safe = Math.max(0, Number(bytes) || 0);
  if (safe >= 1024 ** 4) return `${(safe / 1024 ** 4).toFixed(2)} TB`;
  if (safe >= 1024 ** 3) return `${(safe / 1024 ** 3).toFixed(2)} GB`;
  if (safe >= 1024 ** 2) return `${(safe / 1024 ** 2).toFixed(2)} MB`;
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${Math.round(safe)} B`;
}

function getLocalStatDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDatabasesJson(raw: unknown): DatabaseBackupInfo[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DatabaseBackupInfo[]) : [];
  } catch {
    return [];
  }
}

function countVerifiedAndCorruptedDbs(
  itemRows: Array<Record<string, unknown>>
): { verifiedCount: number; corruptedCount: number } {
  let verifiedCount = 0;
  let corruptedCount = 0;

  for (const row of itemRows) {
    const dbs = parseDatabasesJson(row.databases_list);
    const status = String(row.verification_status || 'UNTESTED');

    if (dbs.length > 0) {
      let rowVerified = 0;
      let rowCorrupted = 0;
      for (const dbItem of dbs) {
        if (dbItem?.verified === true) rowVerified++;
        else if (dbItem?.verified === false && dbItem?.error) rowCorrupted++;
      }
      if (rowVerified === 0 && status === 'PASSED') {
        rowVerified = dbs.length;
      }
      if (rowCorrupted === 0 && status === 'CORRUPTED') {
        rowCorrupted = dbs.length;
      }
      verifiedCount += rowVerified;
      corruptedCount += rowCorrupted;
    } else if (status === 'CORRUPTED') {
      corruptedCount += 1;
    }
  }

  return { verifiedCount, corruptedCount };
}

/**
 * Chụp ảnh thống kê dung lượng ngày (Daily Storage Snapshot) vào bảng `storage_daily_stats`.
 * Tự động Backfill 30 ngày lịch sử từ `backup_jobs` nếu bảng thống kê chưa có dữ liệu.
 */
export function captureDailyStorageSnapshot(): StorageDailyStat {
  const db = getDb();

  const volumeAgg = db
    .prepare(
      `SELECT
         IFNULL(SUM(used_bytes), 0) AS used_bytes,
         IFNULL(SUM(total_bytes), 0) AS total_bytes
       FROM storage_volumes`
    )
    .get();
  const volumesUsedBytes = Number(volumeAgg?.used_bytes || 0);
  const volumesTotalBytes = Number(volumeAgg?.total_bytes || 0);

  // Backfill từ lịch sử backup_jobs nếu hệ thống vừa nâng cấp lên v1.4.0 (< 2 dòng)
  const existingRowsCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM storage_daily_stats').get()?.c || 0
  );
  if (existingRowsCount < 2) {
    const historicalCompleted = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM backup_jobs WHERE job_type = 'BACKUP' AND status = 'COMPLETED'`
        )
        .get()?.c || 0
    );

    if (historicalCompleted > 0) {
      const groupedDays = db
        .prepare(
          `SELECT
             date(COALESCE(completed_at, created_at), 'localtime') AS stat_date,
             SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_cnt,
             SUM(CASE WHEN status = 'FAILED' OR (status = 'INTERRUPTED' AND (retry_count >= 10 OR COALESCE(started_at, created_at) <= datetime('now', '-2 hours'))) THEN 1 ELSE 0 END) AS failed_cnt
           FROM backup_jobs
           WHERE job_type = 'BACKUP'
             AND date(COALESCE(completed_at, created_at), 'localtime') >= date('now', 'localtime', '-30 days')
           GROUP BY date(COALESCE(completed_at, created_at), 'localtime')
           ORDER BY stat_date ASC`
        )
        .all();

      const cumStmt = db.prepare(
        `SELECT
           IFNULL(SUM(total_size_bytes), 0) AS logical_bytes,
           IFNULL(SUM(delta_size_bytes), 0) AS physical_delta_bytes
         FROM backup_jobs
         WHERE job_type = 'BACKUP'
           AND status = 'COMPLETED'
           AND date(COALESCE(completed_at, created_at), 'localtime') <= ?`
      );
      const dayItemsStmt = db.prepare(
        `SELECT bi.databases_list, bi.verification_status
         FROM backup_items bi
         JOIN backup_jobs j ON j.id = bi.job_id
         WHERE j.job_type = 'BACKUP'
           AND j.status = 'COMPLETED'
           AND date(COALESCE(j.completed_at, j.created_at), 'localtime') = ?`
      );
      const insertBackfill = db.prepare(
        `INSERT OR IGNORE INTO storage_daily_stats
         (stat_date, logical_bytes, physical_delta_bytes, volumes_used_bytes, volumes_total_bytes, completed_jobs_count, failed_jobs_count, verified_dbs_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const dayRow of groupedDays) {
        const dayStr = String(dayRow.stat_date || '').trim();
        if (!dayStr) continue;
        const cum = cumStmt.get(dayStr);
        const items = dayItemsStmt.all(dayStr);
        const { verifiedCount } = countVerifiedAndCorruptedDbs(items);
        insertBackfill.run(
          dayStr,
          Number(cum?.logical_bytes || 0),
          Number(cum?.physical_delta_bytes || 0),
          volumesUsedBytes,
          volumesTotalBytes,
          Number(dayRow.completed_cnt || 0),
          Number(dayRow.failed_cnt || 0),
          verifiedCount
        );
      }
    }
  }

  const todayDate = getLocalStatDate();

  const totalSizeAgg = db
    .prepare(
      `SELECT
         IFNULL(SUM(total_size_bytes), 0) AS logical_bytes,
         IFNULL(SUM(delta_size_bytes), 0) AS physical_delta_bytes
       FROM backup_jobs
       WHERE job_type = 'BACKUP' AND status = 'COMPLETED'`
    )
    .get();

  const todayJobCounts = db
    .prepare(
      `SELECT
         IFNULL(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed_cnt,
         IFNULL(SUM(CASE WHEN status = 'FAILED' OR (status = 'INTERRUPTED' AND (retry_count >= 10 OR COALESCE(started_at, created_at) <= datetime('now', '-2 hours'))) THEN 1 ELSE 0 END), 0) AS failed_cnt
       FROM backup_jobs
       WHERE job_type = 'BACKUP'
         AND date(COALESCE(completed_at, created_at), 'localtime') = ?`
    )
    .get(todayDate);

  const todayItems = db
    .prepare(
      `SELECT bi.databases_list, bi.verification_status
       FROM backup_items bi
       JOIN backup_jobs j ON j.id = bi.job_id
       WHERE j.job_type = 'BACKUP'
         AND j.status = 'COMPLETED'
         AND date(COALESCE(j.completed_at, j.created_at), 'localtime') = ?`
    )
    .all(todayDate);

  const { verifiedCount: todayVerifiedDbs } =
    countVerifiedAndCorruptedDbs(todayItems);

  const stat: StorageDailyStat = {
    stat_date: todayDate,
    logical_bytes: Number(totalSizeAgg?.logical_bytes || 0),
    physical_delta_bytes: Number(totalSizeAgg?.physical_delta_bytes || 0),
    volumes_used_bytes: volumesUsedBytes,
    volumes_total_bytes: volumesTotalBytes,
    completed_jobs_count: Number(todayJobCounts?.completed_cnt || 0),
    failed_jobs_count: Number(todayJobCounts?.failed_cnt || 0),
    verified_dbs_count: todayVerifiedDbs,
  };

  db.prepare(
    `INSERT INTO storage_daily_stats
     (stat_date, logical_bytes, physical_delta_bytes, volumes_used_bytes, volumes_total_bytes, completed_jobs_count, failed_jobs_count, verified_dbs_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stat_date) DO UPDATE SET
       logical_bytes = excluded.logical_bytes,
       physical_delta_bytes = excluded.physical_delta_bytes,
       volumes_used_bytes = excluded.volumes_used_bytes,
       volumes_total_bytes = excluded.volumes_total_bytes,
       completed_jobs_count = excluded.completed_jobs_count,
       failed_jobs_count = excluded.failed_jobs_count,
       verified_dbs_count = excluded.verified_dbs_count`
  ).run(
    stat.stat_date,
    stat.logical_bytes,
    stat.physical_delta_bytes,
    stat.volumes_used_bytes,
    stat.volumes_total_bytes,
    stat.completed_jobs_count,
    stat.failed_jobs_count,
    stat.verified_dbs_count
  );

  // Giữ tối đa 90 ngày lịch sử để CSDL gọn nhẹ
  db.prepare(
    `DELETE FROM storage_daily_stats
     WHERE stat_date < date('now', 'localtime', '-90 days')`
  ).run();

  return stat;
}

export function getStorageHistory30Days(): StorageDailyStat[] {
  captureDailyStorageSnapshot();
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT
           stat_date,
           logical_bytes,
           physical_delta_bytes,
           volumes_used_bytes,
           volumes_total_bytes,
           completed_jobs_count,
           failed_jobs_count,
           verified_dbs_count
         FROM storage_daily_stats
         ORDER BY stat_date DESC
         LIMIT 30
       )
       ORDER BY stat_date ASC`
    )
    .all();

  return rows.map((r) => ({
    stat_date: String(r.stat_date),
    logical_bytes: Number(r.logical_bytes || 0),
    physical_delta_bytes: Number(r.physical_delta_bytes || 0),
    volumes_used_bytes: Number(r.volumes_used_bytes || 0),
    volumes_total_bytes: Number(r.volumes_total_bytes || 0),
    completed_jobs_count: Number(r.completed_jobs_count || 0),
    failed_jobs_count: Number(r.failed_jobs_count || 0),
    verified_dbs_count: Number(r.verified_dbs_count || 0),
  }));
}

export function getTopLargestDomains(limit = 10): TopDomainStat[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
  const rows = getDb()
    .prepare(
      `SELECT
         bi.domain_name,
         bi.server_id,
         s.hostname AS server_hostname,
         s.panel_type AS server_panel,
         bi.webroot_size_bytes,
         bi.databases_list,
         bi.verification_status,
         bi.snapshot_name
       FROM backup_items bi
       JOIN (
         SELECT server_id, MAX(id) AS latest_job_id
         FROM backup_jobs
         WHERE job_type = 'BACKUP' AND status = 'COMPLETED'
         GROUP BY server_id
       ) latest ON latest.latest_job_id = bi.job_id
       JOIN servers s ON s.id = bi.server_id`
    )
    .all();

  const stats: TopDomainStat[] = rows.map((r) => {
    const dbs = parseDatabasesJson(r.databases_list);
    const dbSizeBytes = dbs.reduce(
      (sum, d) => sum + (Number(d?.size_bytes) || 0),
      0
    );
    const webrootSizeBytes = Number(r.webroot_size_bytes || 0);
    return {
      domain_name: String(r.domain_name),
      server_id: Number(r.server_id),
      server_hostname: String(r.server_hostname),
      server_panel: String(r.server_panel || 'DIRECTADMIN') as PanelType,
      webroot_size_bytes: webrootSizeBytes,
      db_size_bytes: dbSizeBytes,
      total_domain_bytes: webrootSizeBytes + dbSizeBytes,
      databases_count: dbs.length,
      verification_status: String(
        r.verification_status || 'UNTESTED'
      ) as VerificationStatus,
      snapshot_name: String(r.snapshot_name || ''),
    };
  });

  stats.sort(
    (a, b) =>
      b.total_domain_bytes - a.total_domain_bytes ||
      a.domain_name.localeCompare(b.domain_name)
  );

  return stats.slice(0, safeLimit);
}

export function buildMorningDigestSummary(): MorningDigestSummary {
  const db = getDb();

  const totalServers = Number(
    db.prepare('SELECT COUNT(*) AS c FROM servers').get()?.c || 0
  );
  const onlineServers = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM servers WHERE status IN ('ONLINE', 'BACKUP_RUNNING')`
      )
      .get()?.c || 0
  );
  const hostKeyMismatchCount = Number(
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM servers WHERE host_key_status = 'MISMATCH'`
      )
      .get()?.c || 0
  );

  const window24h = db
    .prepare(
      `SELECT
         IFNULL(SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS succeeded_24h,
         IFNULL(SUM(CASE WHEN status = 'FAILED' OR (status = 'INTERRUPTED' AND (retry_count >= 10 OR COALESCE(started_at, created_at) <= datetime('now', '-2 hours'))) THEN 1 ELSE 0 END), 0) AS failed_24h,
         IFNULL(SUM(CASE WHEN status = 'COMPLETED' THEN delta_size_bytes ELSE 0 END), 0) AS delta_24h,
         IFNULL(SUM(CASE WHEN anomaly_detected = 1 THEN 1 ELSE 0 END), 0) AS anomalies_24h
       FROM backup_jobs
       WHERE job_type = 'BACKUP'
         AND COALESCE(completed_at, created_at) >= datetime('now', '-24 hours')`
    )
    .get();

  const items24h = db
    .prepare(
      `SELECT bi.databases_list, bi.verification_status
       FROM backup_items bi
       JOIN backup_jobs j ON j.id = bi.job_id
       WHERE j.job_type = 'BACKUP'
         AND COALESCE(j.completed_at, j.created_at) >= datetime('now', '-24 hours')`
    )
    .all();

  const { verifiedCount: verifiedDbs24h, corruptedCount: corruptedDbs24h } =
    countVerifiedAndCorruptedDbs(items24h);

  const cumulativeAgg = db
    .prepare(
      `SELECT
         IFNULL(SUM(total_size_bytes), 0) AS logical_bytes,
         IFNULL(SUM(delta_size_bytes), 0) AS physical_delta_bytes
       FROM backup_jobs
       WHERE job_type = 'BACKUP' AND status = 'COMPLETED'`
    )
    .get();

  const totalLogicalBytes = Number(cumulativeAgg?.logical_bytes || 0);
  const totalPhysicalDeltaBytes = Number(
    cumulativeAgg?.physical_delta_bytes || 0
  );
  const savingsPercent =
    totalLogicalBytes > 0
      ? Math.max(
          0,
          ((totalLogicalBytes - totalPhysicalDeltaBytes) / totalLogicalBytes) *
            100
        )
      : 0;

  const volumeRows = db
    .prepare(
      `SELECT name, mount_path, used_bytes, free_bytes, total_bytes, status
       FROM storage_volumes
       ORDER BY priority ASC, id ASC`
    )
    .all();

  const volumes = volumeRows.map((v) => ({
    name: String(v.name),
    mount_path: String(v.mount_path),
    used_bytes: Number(v.used_bytes || 0),
    free_bytes: Number(v.free_bytes || 0),
    total_bytes: Number(v.total_bytes || 0),
    status: String(v.status || 'ACTIVE') as VolumeStatus,
  }));

  return {
    generatedAt: new Date().toISOString(),
    windowHours: 24,
    totalServers,
    onlineServers,
    hostKeyMismatchCount,
    jobsSucceeded24h: Number(window24h?.succeeded_24h || 0),
    jobsFailed24h: Number(window24h?.failed_24h || 0),
    netDeltaBytes24h: Number(window24h?.delta_24h || 0),
    totalLogicalBytes,
    totalPhysicalDeltaBytes,
    savingsPercent: Number(savingsPercent.toFixed(1)),
    verifiedDbs24h,
    corruptedDbs24h,
    anomalies24h: Number(window24h?.anomalies_24h || 0),
    volumes,
  };
}

export async function sendDailyMorningDigest(
  opts: { manual?: boolean } = {}
): Promise<{
  summary: MorningDigestSummary;
  dispatch: NotificationDispatchResult;
}> {
  await refreshAllVolumes().catch(() => {});
  captureDailyStorageSnapshot();

  const summary = buildMorningDigestSummary();
  const dateLabel = new Date().toLocaleDateString('vi-VN');
  const timeLabel = new Date().toLocaleString('vi-VN');
  const triggerTag = opts.manual ? 'Gửi thủ công' : 'Tự động hằng sáng';

  const hasIssues =
    summary.jobsFailed24h > 0 ||
    summary.corruptedDbs24h > 0 ||
    summary.hostKeyMismatchCount > 0 ||
    summary.anomalies24h > 0;
  const headerIcon = hasIssues ? '⚠️' : '☀️';

  const subject = `${headerIcon} [NAS-Sync] Báo cáo NOC Buổi sáng (${dateLabel}) — ${summary.jobsSucceeded24h} OK / ${summary.jobsFailed24h} Lỗi`;

  const volumeLinesTg = summary.volumes.map((v) => {
    const pct =
      v.total_bytes > 0 ? ((v.used_bytes / v.total_bytes) * 100).toFixed(1) : '0.0';
    return `  • <b>${escapeHtml(v.name)}</b>: Trống ${formatBytesHuman(
      v.free_bytes
    )} (Đã dùng ${pct}% — ${escapeHtml(v.status)})`;
  });

  const telegramText = [
    `${headerIcon} <b>[NAS-Sync — Báo cáo NOC Buổi sáng]</b>`,
    `📅 Ngày: <b>${escapeHtml(dateLabel)}</b> (${triggerTag})`,
    '',
    `🖥 <b>Máy chủ VPS:</b> ${summary.onlineServers}/${summary.totalServers} trực tuyến`,
    summary.hostKeyMismatchCount > 0
      ? `🚨 <b>An ninh SSH TOFU:</b> ${summary.hostKeyMismatchCount} máy chủ bị khóa MISMATCH!`
      : `🔐 <b>An ninh SSH TOFU:</b> An toàn (0 MISMATCH)`,
    `📦 <b>Phiên sao lưu (24h):</b> ${summary.jobsSucceeded24h} thành công | ${summary.jobsFailed24h} thất bại`,
    `📈 <b>Delta phát sinh (24h):</b> +${formatBytesHuman(summary.netDeltaBytes24h)}`,
    `💾 <b>Tổng lưu trữ Logic:</b> ${formatBytesHuman(
      summary.totalLogicalBytes
    )} (Tiết kiệm Hard-Link <b>${summary.savingsPercent.toFixed(1)}%</b>)`,
    `🧪 <b>Kiểm định SQL Sandbox (24h):</b> ${summary.verifiedDbs24h} Verified ✅ | ${summary.corruptedDbs24h} CORRUPTED`,
    summary.anomalies24h > 0
      ? `🛡 <b>Cảnh báo Ransomware (24h):</b> ${summary.anomalies24h} phiên bất thường!`
      : `🛡 <b>Ransomware Guard (24h):</b> 0 bất thường`,
    '',
    `🗄 <b>Dung lượng Phân vùng NAS:</b>`,
    ...(volumeLinesTg.length > 0 ? volumeLinesTg : ['  • Chưa cấu hình Volume']),
    '',
    `🕒 ${escapeHtml(timeLabel)}`,
  ].join('\n');

  const volumeRowsHtml = summary.volumes
    .map((v) => {
      const pct =
        v.total_bytes > 0
          ? ((v.used_bytes / v.total_bytes) * 100).toFixed(1)
          : '0.0';
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-weight:600;">${escapeHtml(
          v.name
        )} <span style="color:#64748b;font-weight:400;">(${escapeHtml(
        v.mount_path
      )})</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${formatBytesHuman(
          v.free_bytes
        )}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${pct}%</td>
        <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;">${escapeHtml(
          v.status
        )}</td>
      </tr>`;
    })
    .join('');

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <div style="background:#0f172a;color:#f8fafc;padding:18px 22px;">
        <h2 style="margin:0;font-size:18px;">${headerIcon} NAS-Sync — Báo cáo NOC Buổi sáng (${escapeHtml(
    dateLabel
  )})</h2>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Chế độ gửi: ${escapeHtml(
          triggerTag
        )} | Khung 24 giờ gần nhất</div>
      </div>
      <div style="padding:20px 22px;color:#1e293b;line-height:1.6;">
        <ul style="margin:0 0 16px 0;padding-left:18px;">
          <li><b>Máy chủ VPS:</b> ${summary.onlineServers}/${summary.totalServers} trực tuyến</li>
          <li><b>An ninh SSH Host Key (TOFU):</b> ${
            summary.hostKeyMismatchCount > 0
              ? `<span style="color:#dc2626;font-weight:700;">${summary.hostKeyMismatchCount} MISMATCH (Đã khóa tự động)</span>`
              : '0 MISMATCH (An toàn)'
          }</li>
          <li><b>Phiên Sao lưu (24h):</b> ${summary.jobsSucceeded24h} thành công / ${
    summary.jobsFailed24h
  } lỗi</li>
          <li><b>Dung lượng Delta mới (24h):</b> +${formatBytesHuman(
            summary.netDeltaBytes24h
          )}</li>
          <li><b>Tổng lưu trữ Logic:</b> ${formatBytesHuman(
            summary.totalLogicalBytes
          )} — Tiết kiệm Hard-Link <b>${summary.savingsPercent.toFixed(
    1
  )}%</b></li>
          <li><b>Kiểm định SQL Sandbox (24h):</b> ${
            summary.verifiedDbs24h
          } Verified ✅ | ${summary.corruptedDbs24h} CORRUPTED</li>
          <li><b>Ransomware Anomaly (24h):</b> ${
            summary.anomalies24h
          } cảnh báo</li>
        </ul>
        <h3 style="font-size:14px;margin:16px 0 8px 0;">Trạng thái Phân vùng Lưu trữ NAS</h3>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#f8fafc;text-align:left;">
              <th style="padding:8px 10px;border-bottom:1px solid #cbd5e1;">Volume</th>
              <th style="padding:8px 10px;border-bottom:1px solid #cbd5e1;">Còn trống</th>
              <th style="padding:8px 10px;border-bottom:1px solid #cbd5e1;">Đã dùng</th>
              <th style="padding:8px 10px;border-bottom:1px solid #cbd5e1;">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            ${
              volumeRowsHtml ||
              '<tr><td colspan="4" style="padding:8px 10px;">Chưa có Volume</td></tr>'
            }
          </tbody>
        </table>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0;" />
        <small style="color:#64748b;">Thời gian kết xuất: ${escapeHtml(
          timeLabel
        )} | Hệ thống: ${escapeHtml(
    process.env.APP_URL || 'NAS-Sync'
  )}</small>
      </div>
    </div>
  `;

  const dispatch = await sendDigestNotification(
    subject,
    telegramText,
    htmlBody
  );

  return { summary, dispatch };
}

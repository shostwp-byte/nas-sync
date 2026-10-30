import { getDb, getSetting } from '@/lib/db';
import { createSystemAlert } from '@/lib/notifications';
import type { ServerRecord } from '@/types';

export interface AnomalyCheckResult {
  anomalyDetected: boolean;
  reason: string | null;
  pinnedPreviousCount: number;
}

/**
 * Mục 9.3: Cảnh báo sớm Mã độc / Ransomware & Tự động Pin bản sạch trước đó
 */
export async function evaluateBackupAnomaly(params: {
  jobId: number;
  server: ServerRecord;
  filesTotal: number;
  filesChanged: number;
  deltaSizeBytes: number;
  isFirstBackup: boolean;
  onLog: (msg: string) => void;
}): Promise<AnomalyCheckResult> {
  const {
    jobId,
    server,
    filesTotal,
    filesChanged,
    deltaSizeBytes,
    isFirstBackup,
    onLog,
  } = params;

  if (isFirstBackup || filesTotal === 0) {
    return { anomalyDetected: false, reason: null, pinnedPreviousCount: 0 };
  }

  const maxChangedPct = Number(getSetting('anomaly_max_changed_percent', '50'));
  const maxDeltaGb = Number(getSetting('anomaly_max_delta_gb', '10'));

  const changedPct = (filesChanged / filesTotal) * 100;
  const deltaGb = deltaSizeBytes / 1024 ** 3;

  const reasons: string[] = [];
  if (filesTotal >= 20 && changedPct > maxChangedPct) {
    reasons.push(
      `Tỷ lệ file thay đổi đột biến ${changedPct.toFixed(
        1
      )}% (${filesChanged}/${filesTotal} files > ngưỡng ${maxChangedPct}%)`
    );
  }
  if (deltaGb > maxDeltaGb) {
    reasons.push(
      `Dung lượng phát sinh tăng vọt +${deltaGb.toFixed(
        2
      )} GB (> ngưỡng ${maxDeltaGb} GB)`
    );
  }

  if (reasons.length === 0) {
    return { anomalyDetected: false, reason: null, pinnedPreviousCount: 0 };
  }

  const reasonText = reasons.join('; ');
  const db = getDb();

  // Tự động Khóa (Pin) toàn bộ các bản sao lưu sạch trước đó của VPS này
  const pinRes = db
    .prepare(
      `UPDATE backup_jobs
       SET is_pinned = 1
       WHERE server_id = ? AND id != ? AND status = 'COMPLETED' AND anomaly_detected = 0 AND is_pinned = 0`
    )
    .run(server.id, jobId);

  db.prepare(
    `UPDATE backup_items
     SET is_pinned = 1
     WHERE server_id = ? AND job_id != ? AND is_pinned = 0`
  ).run(server.id, jobId);

  const pinnedCount = Number(pinRes.changes || 0);

  db.prepare(
    `UPDATE backup_jobs SET anomaly_detected = 1, anomaly_reason = ? WHERE id = ?`
  ).run(reasonText, jobId);

  onLog(
    `[ANOMALY ALERT] ⚠️ Phát hiện bất thường: ${reasonText}. Đã tự động KHÓA (Pin) ${pinnedCount} bản backup sạch trước đó!`
  );

  await createSystemAlert({
    severity: 'CRITICAL',
    category: 'ANOMALY',
    title: `Phát hiện bất thường nghi ngờ Ransomware trên ${server.hostname}!`,
    message: `${reasonText}.\nHệ thống đã tự động khóa (Pin) ${pinnedCount} bản sao lưu sạch trước đó của ${server.hostname} để ngăn chính sách Retention xóa nhầm bản sạch.`,
    serverId: server.id,
    jobId,
  });

  return {
    anomalyDetected: true,
    reason: reasonText,
    pinnedPreviousCount: pinnedCount,
  };
}


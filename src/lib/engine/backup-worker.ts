import fs from 'node:fs';
import path from 'node:path';
import { getDb, getSetting } from '@/lib/db';
import { emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import {
  ensureServerHostKeyPinned,
  isTransientSshTransportError,
} from '@/lib/ssh';
import type {
  BackupJob,
  DomainMetadataJson,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { getPanelAdapter } from './adapters';
import { verifyRemoteWebrootSafety } from './adapters/base';
import { evaluateBackupAnomaly } from './anomaly-detector';
import { parseSafeExcludePatterns } from './exclude-rules';
import { syncExtendedHostingExtras } from './extended-hosting-backup';
import { executeMockServerBackup } from './mock-runner';
import { captureDailyStorageSnapshot } from './morning-digest';
import { streamRemoteMysqlDumpToZst } from './mysql-streamer';
import { pushSnapshotToOffsiteCloud } from './offsite-cloud';
import { streamRemotePostgresDumpToZst } from './postgres-streamer';
import { getDirectorySizeAndCount, runRsyncPullDomain } from './rsync-runner';
import { assertSafe, isSafeDbName, isSafeSnapshotName } from './safe-names';
import { verifyJobDatabasesInSandbox } from './sandbox-verifier';
import {
  ensureActiveVolumeForBackup,
  refreshAllVolumes,
  resolveLatestSnapshotDir,
  updateLatestSymlink,
} from './volume-manager';
import {
  RetryableNetworkError,
  clearCancelledJob,
  createJobLogger,
  createJobProgressUpdater,
  isJobCancelled,
  killJobChildProcesses,
  loadOrCreateState,
  registerJobChildProcess,
  requestCancelJob,
  saveState,
  throwIfCancelled,
} from './worker-state';

export {
  RetryableNetworkError,
  clearCancelledJob,
  isJobCancelled,
  killJobChildProcesses,
  registerJobChildProcess,
  requestCancelJob,
  throwIfCancelled,
};

/**
 * Thực thi toàn bộ luồng Sao lưu Cốt lõi cho 1 Job (Mục 5, 6, 7, 9.2, 9.3 + v1.4.0 SSH TOFU Pinning)
 */
export async function executeBackupJob(
  jobId: number,
  options: { verifyDb?: boolean } = {}
): Promise<void> {
  const db = getDb();
  const job = db
    .prepare('SELECT * FROM backup_jobs WHERE id = ?')
    .get(jobId) as unknown as BackupJob | undefined;

  if (!job) {
    throw new Error(`Không tìm thấy Backup Job #${jobId}`);
  }

  let server = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(job.server_id) as unknown as ServerRecord | undefined;

  if (!server) {
    throw new Error(`Không tìm thấy máy chủ ID=${job.server_id}`);
  }

  clearCancelledJob(jobId);

  const appendLog = createJobLogger({
    jobId,
    serverId: server.id,
    hostname: server.hostname,
    initialLog: job.live_log,
  });

  const updateProgress = createJobProgressUpdater({
    jobId,
    serverId: server.id,
    hostname: server.hostname,
  });

  const isResuming = job.retry_count > 0 || job.status === 'INTERRUPTED';

  db.prepare(
    `UPDATE backup_jobs
     SET status = ?, started_at = COALESCE(started_at, datetime('now')), error_log = NULL
     WHERE id = ?`
  ).run(isResuming ? 'RESUMING' : 'RUNNING', jobId);

  db.prepare(`UPDATE servers SET status = 'BACKUP_RUNNING' WHERE id = ?`).run(
    server.id
  );
  emitJobUpdated(jobId);

  try {
    appendLog(
      isResuming
        ? `🔄 Tự động nối tiếp (Auto-Resume lần thử #${job.retry_count}) cho máy chủ ${server.hostname} (${server.panel_type})...`
        : `🚀 Bắt đầu phiên sao lưu tập trung cho máy chủ ${server.hostname} (${server.panel_type})...`
    );

    // 1. Pre-flight Multi-Volume Check & Cross-Volume Seeding (Mục 7)
    updateProgress({
      status: isResuming ? 'RESUMING' : 'RUNNING',
      progressPercent: 3,
      currentPhase: 'Kiểm tra dung lượng phân vùng NAS (Pre-Flight)...',
    });

    const activeVolume = await ensureActiveVolumeForBackup(server, appendLog);
    db.prepare('UPDATE backup_jobs SET volume_id = ? WHERE id = ?').run(
      activeVolume.id,
      jobId
    );

    assertSafe(isSafeSnapshotName, job.snapshot_name, 'Snapshot Name');

    // 1b. Xác thực khóa định danh SSH Host Key (TOFU Pinning & Chống MITM) trước mọi kết nối SSH/Rsync
    updateProgress({
      status: 'RUNNING',
      progressPercent: 5,
      currentPhase: 'Đang xác thực khóa định danh SSH Host Key (TOFU)...',
    });
    const hostKeyCheck = await ensureServerHostKeyPinned(server.id);
    server =
      (db
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get(server.id) as unknown as ServerRecord | undefined) || server;
    appendLog(
      `[SSH TOFU] Xác thực khóa định danh máy chủ thành công (${hostKeyCheck.status}: ${hostKeyCheck.fingerprint}).`
    );

    const hostDir = path.join(activeVolume.mount_path, server.hostname);
    const inProgressDir = path.join(
      hostDir,
      `.in_progress_${job.snapshot_name}`
    );
    const finalSnapshotDir = path.join(hostDir, job.snapshot_name);
    fs.mkdirSync(inProgressDir, { recursive: true });

    const latestSnapshotDir = resolveLatestSnapshotDir(hostDir);
    const isFirstBackup = !latestSnapshotDir;

    if (latestSnapshotDir) {
      appendLog(
        `[Incremental] Phát hiện bản latest (${path.basename(
          latestSnapshotDir
        )}) -> Kích hoạt Hard Link (--link-dest).`
      );
    } else {
      appendLog(
        `[Full Base] Chưa có bản sao lưu trước đó cho ${server.hostname} -> Khởi tạo Full Base đầu tiên.`
      );
    }

    const stateFilePath = path.join(inProgressDir, '.state.json');
    const state = loadOrCreateState(stateFilePath, jobId, job.snapshot_name);

    // 2. Khám phá danh sách User, Domain & thông tin MySQL Admin qua Panel Adapter (Mục 4)
    updateProgress({
      status: 'RUNNING',
      progressPercent: 8,
      currentPhase: `Đang quét cấu trúc ${server.panel_type} qua SSH...`,
    });

    const adapter = getPanelAdapter(server);
    const domains = await adapter.discoverDomains(server);
    const hasMysqlDatabases = domains.some((d) =>
      d.databases.some((dbItem) => dbItem.engine !== 'POSTGRESQL')
    );
    let mysqlCreds: MysqlAdminCredentials | null = null;
    if (server.is_mock || hasMysqlDatabases) {
      mysqlCreds = await adapter.getMysqlAdminCredentials(server);
    }

    db.prepare(
      `UPDATE servers SET last_connected_at = datetime('now') WHERE id = ?`
    ).run(server.id);

    const subCount = domains.filter((d) => d.isSubdomain).length;
    appendLog(
      `[Discovery] Tìm thấy ${domains.length} website (${
        domains.length - subCount
      } domain chính/addon, ${subCount} subdomain) trên máy chủ ${server.hostname}.`
    );

    const globalExcludes = getSetting('global_exclude_patterns', '');
    const customExcludePatterns = parseSafeExcludePatterns(
      globalExcludes,
      server.custom_excludes
    );
    if (customExcludePatterns.length > 0) {
      appendLog(
        `[Exclude Rules] Kích hoạt ${customExcludePatterns.length} quy tắc loại trừ Rsync tùy chỉnh (${customExcludePatterns
          .slice(0, 5)
          .join(', ')}${customExcludePatterns.length > 5 ? ', ...' : ''}).`
      );
    }

    if (domains.length === 0) {
      appendLog(`[Cảnh báo] Không tìm thấy domain nào trên ${server.hostname}.`);
    }

    let aggTotalBytes = 0;
    let aggDeltaBytes = 0;
    let aggFilesTotal = 0;
    let aggFilesChanged = 0;

    // Xóa danh sách backup_items tạm của lần thử bị ngắt trước (nếu có) để ghi chuẩn xác khi commit
    db.prepare('DELETE FROM backup_items WHERE job_id = ?').run(jobId);

    // 3. Lặp qua từng Domain: Đồng bộ mã nguồn + Stream DB + Lưu metadata.json
    for (let idx = 0; idx < domains.length; idx++) {
      throwIfCancelled(jobId);

      const dom = domains[idx];
      const basePct = 10 + Math.round((idx / Math.max(1, domains.length)) * 72);
      const spanPct = Math.round(72 / Math.max(1, domains.length));

      const domainNormalizedDir = path.join(
        inProgressDir,
        'home',
        'domains',
        dom.domain
      );
      const destPublicHtmlDir = path.join(domainNormalizedDir, 'public_html');
      const destDatabasesDir = path.join(domainNormalizedDir, 'databases');
      const linkDestPublicHtmlDir = latestSnapshotDir
        ? path.join(latestSnapshotDir, 'home', 'domains', dom.domain, 'public_html')
        : null;

      let domState = state.completedDomains[dom.domain];
      if (!domState) {
        domState = {
          filesSynced: false,
          webrootSizeBytes: 0,
          filesTotal: 0,
          filesChanged: 0,
          deltaBytes: 0,
          completedDbs: {},
        };
        state.completedDomains[dom.domain] = domState;
      }

      let webrootBackedUp = 1;
      let securityJailViolationReason: string | null = null;

      if (
        domState.filesSynced &&
        Object.keys(domState.completedDbs).length >= dom.databases.length
      ) {
        appendLog(
          `[Auto-Resume] ⏭️ Bỏ qua ${dom.domain} (Đã hoàn thành 100% trước khi ngắt mạng).`
        );
      } else {
        updateProgress({
          progressPercent: basePct,
          currentPhase: `Đang sao lưu mã nguồn (${idx + 1}/${domains.length})`,
          currentDomain: dom.domain,
        });

        if (dom.excludedSubpaths && dom.excludedSubpaths.length > 0) {
          appendLog(
            `[Dedup] ${dom.domain}: Tách riêng thư mục con (${dom.excludedSubpaths
              .map((s) => `/${s}`)
              .join(', ')}) sang gói Subdomain độc lập để không tải trùng lặp.`
          );
        }

        if (server.is_mock) {
          const mockRes = await executeMockServerBackup({
            jobId,
            server,
            domainInfo: dom,
            snapshotName: job.snapshot_name,
            destPublicHtmlDir,
            destDatabasesDir,
            linkDestPublicHtmlDir,
            onProgress: (subPct, speedBps, etaSec) => {
              updateProgress({
                progressPercent: Math.min(
                  85,
                  basePct + Math.round((subPct / 100) * spanPct)
                ),
                speedBps,
                etaSeconds: etaSec,
              });
            },
            onLog: appendLog,
          });

          domState.filesSynced = true;
          domState.webrootSizeBytes = mockRes.totalBytes;
          domState.filesTotal = mockRes.filesTotal;
          domState.filesChanged = mockRes.filesChanged;
          domState.deltaBytes = mockRes.deltaBytes;
          for (const dbi of mockRes.dbResults) {
            domState.completedDbs[dbi.name] = dbi;
          }
          saveState(stateFilePath, state);
        } else {
          // Chế độ Production SSH + Rsync + Zstd Stream
          if (!domState.filesSynced) {
            const safety = await verifyRemoteWebrootSafety(
              server,
              server.panel_type,
              dom.systemUser,
              dom.webroot,
              { mustExist: true }
            );

            if (!safety.ok) {
              if (safety.code === 'SSH_ERROR') {
                throw new RetryableNetworkError(
                  `Mất kết nối SSH khi kiểm tra webroot của ${dom.domain}: ${safety.reason}`,
                  255
                );
              }

              if (safety.code === 'NOT_FOUND') {
                appendLog(
                  `[Cảnh báo] Thư mục webroot ${dom.webroot} của ${dom.domain} chưa tồn tại trên VPS — bỏ qua kéo file và tiếp tục sao lưu Database.`
                );
                fs.mkdirSync(destPublicHtmlDir, { recursive: true });
                domState.filesSynced = true;
                domState.webrootSizeBytes = 0;
                domState.filesTotal = 0;
                domState.filesChanged = 0;
                domState.deltaBytes = 0;
                saveState(stateFilePath, state);
              } else {
                webrootBackedUp = 0;
                securityJailViolationReason = safety.reason;
                appendLog(
                  `[SECURITY] ⛔ Từ chối kéo webroot của ${dom.domain} (${dom.webroot}): ${safety.reason}`
                );
                await createSystemAlert({
                  severity: 'CRITICAL',
                  category: 'BACKUP',
                  title: `[SECURITY] Chặn Symlink Webroot nguy hiểm trên ${server.hostname}`,
                  message: `Domain ${dom.domain} (user: ${dom.systemUser}, webroot: ${dom.webroot}) bị từ chối đồng bộ: ${safety.reason}`,
                  serverId: server.id,
                  jobId,
                });
              }
            } else {
              appendLog(
                `[Rsync] Đồng bộ mã nguồn ${dom.domain} (${dom.webroot})...`
              );
              const syncStats = await runRsyncPullDomain({
                jobId,
                server,
                remoteWebroot: dom.webroot,
                destPublicHtmlDir,
                linkDestPublicHtmlDir,
                excludedSubpaths: dom.excludedSubpaths,
                customExcludes: customExcludePatterns,
                onProgress: (subPct, speedBps, etaSec) => {
                  updateProgress({
                    progressPercent: Math.min(
                      85,
                      basePct + Math.round((subPct / 100) * (spanPct * 0.7))
                    ),
                    speedBps,
                    etaSeconds: etaSec,
                  });
                },
                onLog: appendLog,
              });

              const measured =
                syncStats.totalBytes > 0
                  ? syncStats.totalBytes
                  : getDirectorySizeAndCount(destPublicHtmlDir).totalBytes;

              domState.filesSynced = true;
              domState.webrootSizeBytes = measured;
              domState.filesTotal = syncStats.filesTotal;
              domState.filesChanged = syncStats.filesChanged;
              domState.deltaBytes = syncStats.deltaBytes;
              saveState(stateFilePath, state);
            }
          }

          // Stream từng Database (MySQL / PostgreSQL) qua SSH Pipe về thẳng NAS (Mục 5.3)
          for (const dbEntry of dom.databases) {
            if (domState.completedDbs[dbEntry.name]) {
              appendLog(
                `[Auto-Resume] ⏭️ Bỏ qua DB ${dbEntry.name} (Đã tải xong trước đó).`
              );
              continue;
            }
            const dbEngine =
              dbEntry.engine === 'POSTGRESQL' ? 'POSTGRESQL' : 'MYSQL';
            updateProgress({
              currentPhase: `Đang stream ${dbEngine} Database ${dbEntry.name}`,
              currentDomain: dom.domain,
            });

            if (dbEngine === 'POSTGRESQL') {
              const safePgDb = assertSafe(
                isSafeDbName,
                dbEntry.name,
                'PostgreSQL DB Name'
              );
              const destZstFile = path.join(
                destDatabasesDir,
                `pg_${safePgDb}.sql.zst`
              );
              const pgRes = await streamRemotePostgresDumpToZst({
                jobId,
                server,
                dbName: safePgDb,
                destZstFile,
                onLog: appendLog,
              });
              domState.completedDbs[dbEntry.name] = {
                name: dbEntry.name,
                db_user: dbEntry.user,
                engine: 'POSTGRESQL',
                file: pgRes.fileName,
                size_bytes: pgRes.sizeBytes,
              };
              domState.deltaBytes += pgRes.sizeBytes;
              saveState(stateFilePath, state);
            } else {
              if (!mysqlCreds) {
                mysqlCreds = await adapter.getMysqlAdminCredentials(server);
              }
              const dumpRes = await streamRemoteMysqlDumpToZst({
                jobId,
                server,
                creds: mysqlCreds,
                dbName: dbEntry.name,
                destDatabasesDir,
                onLog: appendLog,
              });
              domState.completedDbs[dbEntry.name] = {
                name: dbEntry.name,
                db_user: dbEntry.user,
                engine: 'MYSQL',
                file: dumpRes.fileName,
                size_bytes: dumpRes.sizeBytes,
              };
              domState.deltaBytes += dumpRes.sizeBytes;
              saveState(stateFilePath, state);
            }
          }
        }
      }

      // Ghi file metadata.json chuẩn hóa (Mục 4.2)
      const dbList = Object.values(domState.completedDbs);
      const metadata: DomainMetadataJson = {
        panel_type: server.panel_type,
        hostname: server.hostname,
        domain_name: dom.domain,
        system_user: dom.systemUser,
        original_webroot: dom.webroot,
        php_version: dom.phpVersion,
        is_subdomain: Boolean(dom.isSubdomain),
        parent_domain: dom.parentDomain,
        excluded_subpaths: dom.excludedSubpaths,
        databases: dbList.map((d) => ({
          name: d.name,
          user: d.db_user,
          engine: d.engine || 'MYSQL',
          dump_file: d.file,
          size_bytes: d.size_bytes,
        })),
        snapshot_name: job.snapshot_name,
        backed_up_at: new Date().toISOString(),
      };
      fs.mkdirSync(domainNormalizedDir, { recursive: true });
      fs.writeFileSync(
        path.join(domainNormalizedDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );

      db.prepare(
        `INSERT INTO backup_items
         (job_id, server_id, volume_id, snapshot_name, system_user, domain_name, source_webroot, webroot_backed_up, webroot_size_bytes, databases_list, php_version, is_subdomain, parent_domain, verification_status, verification_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        jobId,
        server.id,
        activeVolume.id,
        job.snapshot_name,
        dom.systemUser,
        dom.domain,
        dom.webroot,
        webrootBackedUp,
        domState.webrootSizeBytes,
        JSON.stringify(dbList),
        dom.phpVersion,
        dom.isSubdomain ? 1 : 0,
        dom.parentDomain || null,
        securityJailViolationReason ? 'CORRUPTED' : 'UNTESTED',
        securityJailViolationReason
          ? `[SECURITY] ${securityJailViolationReason}`
          : null
      );

      aggTotalBytes +=
        domState.webrootSizeBytes +
        dbList.reduce((acc, item) => acc + item.size_bytes, 0);
      aggDeltaBytes += domState.deltaBytes;
      aggFilesTotal += domState.filesTotal;
      aggFilesChanged += domState.filesChanged;
    }

    // 3b. Sao lưu Mở rộng Hosting (Mailboxes / User Cronjobs / Vhost & SSL Configs - v1.5.0)
    if (
      server.backup_mailboxes ||
      server.backup_cronjobs ||
      server.backup_vhost_configs
    ) {
      throwIfCancelled(jobId);
      updateProgress({
        progressPercent: 83,
        currentPhase:
          'Đang sao lưu mở rộng (Mailboxes / Cronjobs / Vhost & SSL)...',
        currentDomain: '',
      });
      const extrasStats = await syncExtendedHostingExtras({
        jobId,
        server,
        domains,
        inProgressDir,
        latestSnapshotDir,
        appendLog,
      });
      aggTotalBytes += extrasStats.totalBytes;
      aggDeltaBytes += extrasStats.deltaBytes;
    }

    // 4. Hoàn tất nguyên tử (Atomic Commit - Mục 6.2.4)
    updateProgress({
      progressPercent: 86,
      currentPhase: 'Đang thực hiện Atomic Commit bản sao lưu...',
      currentDomain: '',
      speedBps: 0,
      etaSeconds: 2,
    });

    fs.rmSync(stateFilePath, { force: true });
    if (fs.existsSync(finalSnapshotDir)) {
      fs.rmSync(finalSnapshotDir, { recursive: true, force: true });
    }
    fs.renameSync(inProgressDir, finalSnapshotDir);

    appendLog(
      `[Atomic Commit] Đã chuyển giao nguyên tử sang ${finalSnapshotDir}.`
    );

    db.prepare(
      `UPDATE backup_jobs
       SET total_size_bytes = ?, delta_size_bytes = ?, files_total = ?, files_changed = ?
       WHERE id = ?`
    ).run(aggTotalBytes, aggDeltaBytes, aggFilesTotal, aggFilesChanged, jobId);

    // 5. Phân tích bất thường / Ransomware Anomaly Detection (Mục 9.3)
    const anomalyResult = await evaluateBackupAnomaly({
      jobId,
      server,
      filesTotal: aggFilesTotal,
      filesChanged: aggFilesChanged,
      deltaSizeBytes: aggDeltaBytes,
      isFirstBackup,
      onLog: appendLog,
    });

    // 6. Kiểm thử tính toàn vẹn SQL trên MariaDB Sandbox (Mục 9.2)
    if (options.verifyDb !== false) {
      updateProgress({
        status: 'VERIFYING',
        progressPercent: 92,
        currentPhase: 'Đang nạp thử kiểm định Database trên Sandbox...',
      });
      const verifyResults = await verifyJobDatabasesInSandbox(
        jobId,
        finalSnapshotDir,
        appendLog
      );
      const corruptedDomains = verifyResults.filter(
        (r) => r.status === 'CORRUPTED'
      );
      if (corruptedDomains.length > 0) {
        await createSystemAlert({
          severity: 'WARNING',
          category: 'BACKUP',
          title: `Phát hiện ${corruptedDomains.length} domain lỗi kiểm định trên ${server.hostname}`,
          message: `Job #${jobId} (${job.snapshot_name}) ghi nhận lỗi kiểm định toàn vẹn: ${corruptedDomains
            .map((c) => `${c.domainName} (${c.detail})`)
            .join('; ')}`,
          serverId: server.id,
          jobId,
        });
      }
    }

    if (!anomalyResult.anomalyDetected) {
      await updateLatestSymlink(hostDir, finalSnapshotDir);
      appendLog(
        `[Latest Pointer] Đã cập nhật con trỏ symlink latest sang bản sạch ${job.snapshot_name}.`
      );
    } else {
      appendLog(
        `[Ransomware Guard] ⚠️ Phát hiện dấu hiệu bất thường — Giữ nguyên symlink latest ở bản sạch trước đó (không trỏ sang ${job.snapshot_name}) để bảo vệ chuỗi Incremental Hard-Link & Quick Restore.`
      );
    }

    await refreshAllVolumes();

    db.prepare(
      `UPDATE backup_jobs
       SET status = 'COMPLETED', progress_percent = 100, current_phase = 'Hoàn tất 100%',
           current_domain = '', speed_bps = 0, eta_seconds = 0, completed_at = datetime('now')
       WHERE id = ?`
    ).run(jobId);

    db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
      server.id
    );

    try {
      captureDailyStorageSnapshot();
    } catch {
      // Ignore stats snapshot errors
    }

    appendLog(
      `✅ Sao lưu hoàn tất 100%! Tổng dung lượng bản backup: ${(
        aggTotalBytes /
        1024 ** 2
      ).toFixed(2)} MB | Dung lượng tăng thêm thực tế (Delta): ${(
        aggDeltaBytes /
        1024 ** 2
      ).toFixed(2)} MB.`
    );

    updateProgress({
      status: 'COMPLETED',
      progressPercent: 100,
      currentPhase: 'Hoàn tất sao lưu & kiểm định',
      speedBps: 0,
      etaSeconds: 0,
      totalSizeBytes: aggTotalBytes,
      deltaSizeBytes: aggDeltaBytes,
    });
    emitJobUpdated(jobId);

    // 7. Đồng bộ Offsite Cloud 3-2-1 tự động (v1.5.0 — không làm hỏng bản sao lưu nội bộ nếu mạng Cloud lỗi)
    const offsiteProvider = getSetting('offsite_provider', 'NONE')
      .trim()
      .toUpperCase();
    const offsiteAutoPush = getSetting('offsite_auto_push', 'NONE')
      .trim()
      .toUpperCase();
    const shouldPushOffsite =
      offsiteProvider !== 'NONE' &&
      (offsiteAutoPush === 'EVERY_BACKUP' ||
        (offsiteAutoPush === 'WEEKLY_SUNDAY' && new Date().getDay() === 0));

    if (shouldPushOffsite) {
      appendLog(
        `☁️ [Offsite Cloud] Đang mã hóa luồng AES-256-GCM và đẩy bản sao lưu lên ${offsiteProvider} (${offsiteAutoPush})...`
      );
      try {
        const syncedJob = await pushSnapshotToOffsiteCloud(jobId, {
          triggerSource: offsiteAutoPush,
        });
        appendLog(
          `☁️ [Offsite Cloud] ✅ Đã tải lên ${offsiteProvider} thành công: ${syncedJob.remote_object_key} (${(
            syncedJob.encrypted_size_bytes /
            1024 ** 2
          ).toFixed(2)} MB trong ${syncedJob.duration_seconds}s).`
        );
      } catch (offsiteErr) {
        appendLog(
          `☁️ [Offsite Cloud] ⚠️ Cảnh báo đồng bộ Cloud (bản sao lưu nội bộ trên NAS vẫn an toàn): ${
            (offsiteErr as Error).message
          }`
        );
      }
    }
  } catch (rawErr) {
    let err = rawErr;
    if (
      !(err instanceof RetryableNetworkError) &&
      !isJobCancelled(jobId) &&
      isTransientSshTransportError(255, (err as Error)?.message || '')
    ) {
      err = new RetryableNetworkError(
        (err as Error)?.message || 'Gián đoạn kết nối SSH tạm thời.',
        255
      );
    }

    if (err instanceof RetryableNetworkError) {
      const nextRetry = job.retry_count + 1;
      appendLog(
        `⚠️ Gián đoạn kết nối mạng: ${err.message}. Hệ thống lưu trạng thái .state.json và chuyển sang INTERRUPTED để tự động nối tiếp (Lần thử ${nextRetry}/10).`
      );
      db.prepare(
        `UPDATE backup_jobs
         SET status = 'INTERRUPTED', current_phase = 'Mất kết nối — Đang chờ tự động Resume...',
             speed_bps = 0, retry_count = ?, error_log = ?
         WHERE id = ?`
      ).run(nextRetry, err.message, jobId);
      db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
        server.id
      );
      emitJobUpdated(jobId);
      throw err;
    }

    const finalStatus = isJobCancelled(jobId) ? 'CANCELLED' : 'FAILED';
    const errMsg = (err as Error).message || 'Lỗi không xác định';
    appendLog(`❌ Phiên sao lưu dừng (${finalStatus}): ${errMsg}`);

    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, current_phase = ?, speed_bps = 0, eta_seconds = 0,
           completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(
      finalStatus,
      finalStatus === 'CANCELLED' ? 'Đã hủy bởi người dùng' : 'Thất bại',
      errMsg,
      jobId
    );

    db.prepare(`UPDATE servers SET status = ? WHERE id = ?`).run(
      finalStatus === 'CANCELLED' ? 'ONLINE' : 'ERROR',
      server.id
    );

    try {
      captureDailyStorageSnapshot();
    } catch {
      // Ignore stats snapshot errors
    }

    if (finalStatus === 'FAILED') {
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'BACKUP',
        title: `Sao lưu thất bại trên máy chủ ${server.hostname}`,
        message: `Job #${jobId} (${job.snapshot_name}) gặp lỗi: ${errMsg}`,
        serverId: server.id,
        jobId,
      });
    }

    emitJobUpdated(jobId);
    throw err;
  } finally {
    clearCancelledJob(jobId);
  }
}

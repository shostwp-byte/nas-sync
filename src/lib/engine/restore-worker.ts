import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress, emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  ensureServerHostKeyPinned,
  execRemoteSSH,
  shellSingleQuote,
} from '@/lib/ssh';
import type {
  BackupItem,
  BackupJob,
  DatabaseBackupInfo,
  DomainMetadataJson,
  MysqlAdminCredentials,
  RestoreRequestPayload,
  ServerRecord,
  StorageVolume,
} from '@/types';
import { getPanelAdapter } from './adapters';
import {
  buildMysqlAuthFlags,
  buildRemoteMysqlEnvPrelude,
  verifyRemoteWebrootSafety,
} from './adapters/base';
import { patchRestoredWebConfigOverSsh } from './config-rewriter';
import {
  assertSafe,
  isSafeDbName,
  isSafeDomain,
  isSafeSnapshotName,
  isSafeSystemUser,
  isSafeWebroot,
} from './safe-names';
import {
  clearCancelledJob,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
} from './worker-state';

const RESTORE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function pushFilesViaRsync(params: {
  jobId: number;
  targetServer: ServerRecord;
  localPublicHtmlDir: string;
  targetWebroot: string;
  excludedSubpaths?: string[];
  onProgress: (pct: number) => void;
}): Promise<void> {
  const {
    jobId,
    targetServer,
    localPublicHtmlDir,
    targetWebroot,
    excludedSubpaths,
    onProgress,
  } = params;

  const args: string[] = [
    '-az',
    '--delete',
    '--no-devices',
    '--no-specials',
    '--safe-links',
    '--info=progress2',
    '--timeout=60',
  ];
  if (excludedSubpaths && excludedSubpaths.length > 0) {
    for (const rel of excludedSubpaths) {
      const cleanRel = rel.replace(/^\/+|\/+$/g, '');
      if (cleanRel && !cleanRel.includes('..') && !/[\r\n\0]/.test(cleanRel)) {
        args.push(`--exclude=/${cleanRel}`);
      }
    }
  }
  if (targetServer.bw_limit_kbps && targetServer.bw_limit_kbps > 0) {
    args.push(`--bwlimit=${targetServer.bw_limit_kbps}`);
  }
  args.push('-e', buildRsyncSshTransport(targetServer));
  args.push('--rsync-path=ionice -c2 -n7 nice -n19 rsync');
  args.push(
    `${localPublicHtmlDir.replace(/\/+$/, '')}/`,
    `${targetServer.ssh_user || 'root'}@${
      targetServer.ip_address
    }:${targetWebroot.replace(/\/+$/, '')}/`
  );

  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    registerJobChildProcess(jobId, child);
    let stderr = '';
    let lastActivityAt = Date.now();
    let idleTimedOut = false;

    const watcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > RESTORE_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      const m = chunk.toString('utf8').match(/(\d+)%/);
      if (m) {
        onProgress(Math.min(100, Number(m[1])));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      stderr += chunk.toString('utf8');
      if (stderr.length > 65536) {
        stderr = stderr.slice(-32768);
      }
    });
    child.on('error', (err) => {
      clearInterval(watcher);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watcher);
      if (isJobCancelled(jobId)) {
        reject(new Error('Job khôi phục đã bị hủy bởi quản trị viên.'));
        return;
      }
      if (idleTimedOut) {
        reject(
          new Error(
            'Rsync Restore bị treo quá 30 phút không có phản hồi dữ liệu.'
          )
        );
        return;
      }
      if (code === 0 || code === 24) resolve();
      else reject(new Error(`Rsync Restore lỗi (code ${code}): ${stderr.trim()}`));
    });
  });
}

function streamRestoreDatabaseOverSsh(params: {
  jobId: number;
  targetServer: ServerRecord;
  creds: MysqlAdminCredentials;
  dumpFilePath: string;
  targetDbName: string;
}): Promise<void> {
  const { jobId, targetServer, creds, dumpFilePath, targetDbName } = params;

  return new Promise((resolve, reject) => {
    const ext = path.extname(dumpFilePath).toLowerCase();
    const decompCmd =
      ext === '.zst' ? 'zstd -dc' : ext === '.gz' ? 'gzip -dc' : 'cat';

    const authFlags = buildMysqlAuthFlags(creds);
    const envPrelude = buildRemoteMysqlEnvPrelude(creds);

    const remoteInner = `${envPrelude}mysql ${authFlags} ${shellSingleQuote(targetDbName)}`;
    const remoteMysqlCmd = `bash -o pipefail -c ${shellSingleQuote(remoteInner)}`;
    const pipeline = `set -o pipefail; dump="$1"; shift; ${decompCmd} -- "$dump" | ssh "$@"`;

    const child = spawn(
      'bash',
      [
        '-c',
        pipeline,
        'restore-db',
        dumpFilePath,
        ...buildSshBaseArgs(targetServer),
        '--',
        `${targetServer.ssh_user || 'root'}@${targetServer.ip_address}`,
        remoteMysqlCmd,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    registerJobChildProcess(jobId, child);

    let stderr = '';
    let lastActivityAt = Date.now();
    let idleTimedOut = false;

    const watcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > RESTORE_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', () => {
      lastActivityAt = Date.now();
    });
    child.stderr.on('data', (d: Buffer) => {
      lastActivityAt = Date.now();
      stderr += d.toString('utf8');
      if (stderr.length > 65536) {
        stderr = stderr.slice(-32768);
      }
    });
    child.on('error', (err) => {
      clearInterval(watcher);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(watcher);
      if (isJobCancelled(jobId)) {
        reject(new Error('Job khôi phục đã bị hủy bởi quản trị viên.'));
        return;
      }
      if (idleTimedOut) {
        reject(
          new Error(
            `Nạp Database ${targetDbName} quá thời gian chờ 30 phút (Idle Timeout).`
          )
        );
        return;
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Nạp Database ${targetDbName} thất bại (code ${code}): ${stderr.trim()}`
          )
        );
    });
  });
}

/**
 * Mục 8: Cơ chế Khôi phục Đa năng (Files Only / DB Only / Cross-Panel Migration + SSH TOFU Pinning)
 */
export async function executeRestoreJob(jobId: number): Promise<void> {
  const db = getDb();
  const job = db
    .prepare('SELECT * FROM backup_jobs WHERE id = ?')
    .get(jobId) as unknown as BackupJob | undefined;
  if (!job || !job.restore_options) {
    throw new Error(`Không tìm thấy thông tin cấu hình Restore cho Job #${jobId}`);
  }

  const payload = JSON.parse(job.restore_options) as RestoreRequestPayload;

  const itemRow = db
    .prepare('SELECT * FROM backup_items WHERE id = ?')
    .get(payload.backupItemId) as Record<string, unknown> | undefined;
  if (!itemRow) {
    throw new Error(`Không tìm thấy bản sao lưu domain #${payload.backupItemId}`);
  }

  const item: BackupItem = {
    ...(itemRow as unknown as BackupItem),
    databases_list: JSON.parse(String(itemRow.databases_list || '[]')),
  };

  const sourceServer = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(item.server_id) as unknown as ServerRecord;
  let targetServer = db
    .prepare('SELECT * FROM servers WHERE id = ?')
    .get(payload.targetServerId) as unknown as ServerRecord;
  const sourceVolume = db
    .prepare('SELECT * FROM storage_volumes WHERE id = ?')
    .get(item.volume_id) as unknown as StorageVolume;

  if (!sourceServer || !targetServer || !sourceVolume) {
    throw new Error('Thiếu thông tin máy chủ nguồn, máy chủ đích hoặc Volume lưu trữ.');
  }

  const isCrossPanel =
    sourceServer.id !== targetServer.id ||
    sourceServer.panel_type !== targetServer.panel_type;

  const logLines: string[] = [];
  const appendLog = (msg: string) => {
    const ts = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const line = `[${ts}] ${msg}`;
    logLines.push(line);
    if (logLines.length > 250) {
      logLines.shift();
    }
    db.prepare('UPDATE backup_jobs SET live_log = ? WHERE id = ?').run(
      logLines.join('\n'),
      jobId
    );
    emitJobLog({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      line,
      timestamp: ts,
    });
  };

  const setStep = (pct: number, phase: string) => {
    db.prepare(
      `UPDATE backup_jobs SET status = 'RUNNING', progress_percent = ?, current_phase = ?, current_domain = ? WHERE id = ?`
    ).run(pct, phase, item.domain_name, jobId);
    emitJobProgress({
      jobId,
      serverId: targetServer.id,
      hostname: targetServer.hostname,
      status: 'RUNNING',
      progressPercent: pct,
      currentPhase: phase,
      currentDomain: item.domain_name,
      speedBps: 0,
      etaSeconds: 0,
      deltaSizeBytes: 0,
      totalSizeBytes: item.webroot_size_bytes,
      retryCount: 0,
    });
  };

  db.prepare(
    `UPDATE backup_jobs SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?`
  ).run(jobId);
  emitJobUpdated(jobId);

  try {
    if (isJobCancelled(jobId)) {
      throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
    }

    const targetDomain = assertSafe(
      isSafeDomain,
      (payload.targetDomainName || item.domain_name).trim(),
      'Tên miền đích'
    );
    const targetUser = assertSafe(
      isSafeSystemUser,
      (payload.targetSystemUser || item.system_user).trim(),
      'User hệ thống đích'
    );
    assertSafe(isSafeDomain, item.domain_name, 'Tên miền nguồn trong bản sao lưu');
    assertSafe(isSafeSnapshotName, item.snapshot_name, 'Snapshot nguồn');

    // Xác thực khóa định danh SSH Host Key (TOFU Pinning & Chống MITM) cho máy chủ đích trước khi kết nối SSH
    setStep(10, 'Đang xác thực khóa định danh SSH Host Key máy chủ đích (TOFU)...');
    const pinnedTarget = await ensureServerHostKeyPinned(targetServer.id);
    targetServer =
      (db
        .prepare('SELECT * FROM servers WHERE id = ?')
        .get(targetServer.id) as unknown as ServerRecord | undefined) ||
      targetServer;
    appendLog(
      `[SSH TOFU] Xác thực khóa định danh máy chủ đích ${targetServer.hostname} (${pinnedTarget.status}: ${pinnedTarget.fingerprint}).`
    );

    const targetAdapter = getPanelAdapter(targetServer);

    const resolvedWebroot = assertSafe(
      (v) => isSafeWebroot(v.replace(/\/+$/, '')),
      payload.targetWebrootOverride?.trim() ||
        (await targetAdapter.resolveTargetWebroot(
          targetServer,
          targetUser,
          targetDomain
        )),
      'Webroot đích'
    );

    const sourceDomainDir = path.join(
      sourceVolume.mount_path,
      sourceServer.hostname,
      item.snapshot_name,
      'home',
      'domains',
      item.domain_name
    );
    const localPublicHtml = path.join(sourceDomainDir, 'public_html');
    const localDatabasesDir = path.join(sourceDomainDir, 'databases');
    const metadataPath = path.join(sourceDomainDir, 'metadata.json');
    let savedExcludedSubpaths: string[] = [];
    const shouldPreserveExcludedSubpaths =
      !payload.targetWebrootOverride?.trim() &&
      sourceServer.panel_type === targetServer.panel_type;
    if (shouldPreserveExcludedSubpaths && fs.existsSync(metadataPath)) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(metadataPath, 'utf8')
        ) as DomainMetadataJson;
        if (Array.isArray(meta.excluded_subpaths)) {
          savedExcludedSubpaths = meta.excluded_subpaths.filter(
            (s) => typeof s === 'string' && !s.includes('..') && !/[\r\n\0]/.test(s)
          );
        }
      } catch {
        // Ignore invalid metadata
      }
    }

    appendLog(
      isCrossPanel
        ? `🔄 Bắt đầu Di chuyển Chéo (Cross-Panel Restore): ${sourceServer.hostname} (${sourceServer.panel_type}) ➔ ${targetServer.hostname} (${targetServer.panel_type})`
        : `♻️ Bắt đầu Khôi phục dữ liệu (${payload.mode}) cho ${targetDomain} về ${targetServer.hostname} (${targetServer.panel_type})`
    );

    const permCmd = targetAdapter.buildPermissionFixCommand(
      targetUser,
      targetDomain,
      resolvedWebroot
    );

    const mockRestoreDest = path.join(
      getDataDir(),
      'restored_preview',
      targetServer.hostname,
      targetDomain,
      'public_html'
    );

    // 1. Khôi phục Mã nguồn (Files)
    if (payload.mode === 'FILES_ONLY' || payload.mode === 'FULL') {
      if (isJobCancelled(jobId)) {
        throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
      }

      if (!fs.existsSync(localPublicHtml)) {
        throw new Error(
          `Không tìm thấy thư mục mã nguồn tại ${localPublicHtml}`
        );
      }

      setStep(20, `Đang kiểm tra an toàn & đẩy mã nguồn lên ${resolvedWebroot}...`);
      appendLog(
        `[Files Restore] Nguồn NAS: ${localPublicHtml} ➔ Đích VPS: ${targetServer.hostname}:${resolvedWebroot}`
      );

      if (targetServer.is_mock) {
        await new Promise((r) => setTimeout(r, 450));
        fs.mkdirSync(mockRestoreDest, { recursive: true });
        fs.cpSync(localPublicHtml, mockRestoreDest, {
          recursive: true,
          force: true,
        });
        setStep(55, `Đang chuẩn hóa phân quyền ${targetServer.panel_type}...`);
        await new Promise((r) => setTimeout(r, 300));
        appendLog(
          `[Permissions] Đã thực thi chuẩn hóa quyền trên ${targetServer.panel_type}: ${permCmd}`
        );
      } else {
        const safety = await verifyRemoteWebrootSafety(
          targetServer,
          targetServer.panel_type,
          targetUser,
          resolvedWebroot,
          { mustExist: false }
        );
        if (!safety.ok) {
          throw new Error(
            `[SECURITY] Từ chối khôi phục mã nguồn vào đường dẫn không an toàn (${resolvedWebroot}): ${safety.reason}`
          );
        }

        await execRemoteSSH(
          targetServer,
          `mkdir -p ${shellSingleQuote(resolvedWebroot)}`,
          { zeroImpact: true }
        );
        if (savedExcludedSubpaths.length > 0) {
          appendLog(
            `[Safe Restore] Bảo vệ thư mục Subdomain lồng bên trong (${savedExcludedSubpaths
              .map((s) => `/${s}`)
              .join(', ')}) không bị ghi đè/xóa khi khôi phục domain cha.`
          );
        }
        await pushFilesViaRsync({
          jobId,
          targetServer,
          localPublicHtmlDir: localPublicHtml,
          targetWebroot: resolvedWebroot,
          excludedSubpaths: savedExcludedSubpaths,
          onProgress: (p) =>
            setStep(
              20 + Math.round(p * 0.35),
              `Đang đồng bộ mã nguồn (${p}%)...`
            ),
        });
        setStep(58, `Đang gán quyền chủ sở hữu (${targetServer.panel_type})...`);
        const chownRes = await execRemoteSSH(targetServer, permCmd, {
          zeroImpact: true,
        });
        if (chownRes.code !== 0) {
          appendLog(
            `[Cảnh báo] Lệnh phân quyền trả về mã ${chownRes.code}: ${chownRes.stderr.trim()}`
          );
        } else {
          appendLog(`[Permissions] Đã thực thi thành công: ${permCmd}`);
        }
      }
    }

    // 2. Khôi phục Database
    if (payload.mode === 'DB_ONLY' || payload.mode === 'FULL') {
      const dbsToRestore: DatabaseBackupInfo[] = payload.selectedDatabases?.length
        ? item.databases_list.filter((d) =>
            payload.selectedDatabases!.includes(d.name)
          )
        : item.databases_list;

      if (dbsToRestore.length === 0) {
        appendLog(`[DB Restore] Không có database nào được chọn hoặc domain không dùng DB.`);
      } else {
        const creds = await targetAdapter.getMysqlAdminCredentials(targetServer);
        const authFlags = buildMysqlAuthFlags(creds);
        const envPrelude = buildRemoteMysqlEnvPrelude(creds);

        for (let i = 0; i < dbsToRestore.length; i++) {
          if (isJobCancelled(jobId)) {
            throw new Error('Job khôi phục đã bị hủy bởi quản trị viên.');
          }

          const dbInfo = dbsToRestore[i];
          const targetDbName = assertSafe(
            isSafeDbName,
            payload.targetDbMap?.[dbInfo.name]?.trim() || dbInfo.name,
            'Tên database đích'
          );

          if (
            !dbInfo.file ||
            path.basename(dbInfo.file) !== dbInfo.file ||
            dbInfo.file.includes('..') ||
            /[/\\\0]/.test(dbInfo.file)
          ) {
            throw new Error(
              `Tên file dump SQL không hợp lệ: ${JSON.stringify(dbInfo.file)}`
            );
          }

          const dumpPath = path.join(localDatabasesDir, dbInfo.file);

          if (!fs.existsSync(dumpPath)) {
            throw new Error(`Không tìm thấy file backup SQL tại ${dumpPath}`);
          }

          setStep(
            65 + Math.round(((i + 1) / dbsToRestore.length) * 30),
            `Đang giải nén luồng & nạp Database ${targetDbName}...`
          );

          appendLog(
            `[DB Stream Restore] Stream ${dbInfo.file} ➔ MySQL(${targetServer.hostname}) / DB: ${targetDbName}`
          );

          if (targetServer.is_mock) {
            await new Promise((r) => setTimeout(r, 450));
            appendLog(
              `[DB Stream Restore] ✅ Đã nạp thành công toàn bộ bảng vào database "${targetDbName}" trên ${targetServer.hostname}.`
            );
          } else {
            const createDbCmd = `bash -o pipefail -c ${shellSingleQuote(
              `${envPrelude}mysql ${authFlags} -e "CREATE DATABASE IF NOT EXISTS \\\`${targetDbName}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`
            )}`;
            const createRes = await execRemoteSSH(targetServer, createDbCmd, {
              zeroImpact: true,
            });
            if (createRes.code !== 0) {
              throw new Error(
                `Không thể khởi tạo database đích "${targetDbName}": ${createRes.stderr.trim()}`
              );
            }
            await streamRestoreDatabaseOverSsh({
              jobId,
              targetServer,
              creds,
              dumpFilePath: dumpPath,
              targetDbName,
            });
            appendLog(
              `[DB Stream Restore] ✅ Hoàn tất nạp Database "${targetDbName}".`
            );
          }
        }
      }
    }

    // 3. Tự động cập nhật cấu hình kết nối DB & đường dẫn Webroot khi Di chuyển Chéo (Cross-Panel Config Rewriter)
    if (payload.autoPatchConfig && payload.mode !== 'DB_ONLY') {
      setStep(96, 'Đang tự động hiệu chỉnh cấu hình kết nối Web / Database...');
      const patchRes = await patchRestoredWebConfigOverSsh({
        server: targetServer,
        targetUser,
        targetDomain,
        targetWebroot: resolvedWebroot,
        sourceWebroot: item.source_webroot || '',
        dbRenameMap: payload.targetDbMap || {},
        isMock: Boolean(targetServer.is_mock),
        mockWebrootDir: targetServer.is_mock ? mockRestoreDest : undefined,
        onLog: appendLog,
      });

      if (patchRes.patchedFiles.length > 0) {
        if (!targetServer.is_mock) {
          const reChown = await execRemoteSSH(targetServer, permCmd, {
            zeroImpact: true,
          });
          if (reChown.code !== 0) {
            appendLog(
              `[Cảnh báo] Lệnh chuẩn hóa lại quyền sau khi cập nhật cấu hình trả về mã ${reChown.code}: ${reChown.stderr.trim()}`
            );
          }
        }
        appendLog(
          `[Config Rewriter] ✅ Đã cập nhật thành công ${patchRes.patchedFiles.length} tệp cấu hình: ${patchRes.patchedFiles.join(', ')}.`
        );
      } else {
        appendLog(
          `[Config Rewriter] Không phát hiện thông số DB / đường dẫn cũ cần sửa đổi trong các tệp cấu hình.`
        );
      }
    }

    db.prepare(
      `UPDATE backup_jobs
       SET status = 'COMPLETED', progress_percent = 100, current_phase = 'Khôi phục hoàn tất 100%',
           completed_at = datetime('now')
       WHERE id = ?`
    ).run(jobId);

    appendLog(
      `🎉 Khôi phục ${targetDomain} sang ${targetServer.hostname} (${targetServer.panel_type}) hoàn tất 100%!`
    );

    await createSystemAlert({
      severity: 'INFO',
      category: 'RESTORE',
      title: `Khôi phục thành công ${targetDomain} ➔ ${targetServer.hostname}`,
      message: `Chế độ: ${payload.mode} | Nguồn: ${sourceServer.hostname} (${item.snapshot_name}) | Đích: ${targetServer.hostname} (${targetServer.panel_type} - ${resolvedWebroot}).`,
      serverId: targetServer.id,
      jobId,
      notifyExternal: false,
    });

    emitJobUpdated(jobId);
  } catch (err) {
    const cancelled = isJobCancelled(jobId);
    const errMsg = (err as Error).message;
    appendLog(
      cancelled
        ? `⏹️ Phiên khôi phục đã bị hủy: ${errMsg}`
        : `❌ Khôi phục thất bại: ${errMsg}`
    );
    db.prepare(
      `UPDATE backup_jobs
       SET status = ?, current_phase = ?, completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(
      cancelled ? 'CANCELLED' : 'FAILED',
      cancelled ? 'Đã hủy bởi quản trị viên' : 'Khôi phục thất bại',
      errMsg,
      jobId
    );

    if (!cancelled) {
      await createSystemAlert({
        severity: 'CRITICAL',
        category: 'RESTORE',
        title: `Khôi phục thất bại cho ${item.domain_name}`,
        message: errMsg,
        serverId: targetServer.id,
        jobId,
      });
    }

    emitJobUpdated(jobId);
    throw err;
  } finally {
    clearCancelledJob(jobId);
  }
}

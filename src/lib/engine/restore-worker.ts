import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getDb } from '@/lib/db';
import { emitJobLog, emitJobProgress, emitJobUpdated } from '@/lib/events';
import { createSystemAlert } from '@/lib/notifications';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  execRemoteSSH,
  shellSingleQuote,
} from '@/lib/ssh';
import type {
  BackupItem,
  BackupJob,
  DatabaseBackupInfo,
  DomainMetadataJson,
  RestoreRequestPayload,
  ServerRecord,
  StorageVolume,
} from '@/types';
import { getPanelAdapter } from './adapters';
import { buildMysqlAuthFlags } from './adapters/base';

function pushFilesViaRsync(params: {
  targetServer: ServerRecord;
  localPublicHtmlDir: string;
  targetWebroot: string;
  excludedSubpaths?: string[];
  onProgress: (pct: number) => void;
}): Promise<void> {
  const {
    targetServer,
    localPublicHtmlDir,
    targetWebroot,
    excludedSubpaths,
    onProgress,
  } = params;

  const args: string[] = [
    '-az',
    '--delete',
    '--info=progress2',
    '--timeout=60',
  ];
  if (excludedSubpaths && excludedSubpaths.length > 0) {
    for (const rel of excludedSubpaths) {
      const cleanRel = rel.replace(/^\/+|\/+$/g, '');
      if (cleanRel) {
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
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const m = chunk.toString('utf8').match(/(\d+)%/);
      if (m) {
        onProgress(Math.min(100, Number(m[1])));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0 || code === 24) resolve();
      else reject(new Error(`Rsync Restore lỗi (code ${code}): ${stderr.trim()}`));
    });
  });
}

function streamRestoreDatabaseOverSsh(params: {
  targetServer: ServerRecord;
  authFlags: string;
  dumpFilePath: string;
  targetDbName: string;
}): Promise<void> {
  const { targetServer, authFlags, dumpFilePath, targetDbName } = params;

  return new Promise((resolve, reject) => {
    const ext = path.extname(dumpFilePath).toLowerCase();
    const decompCmd =
      ext === '.zst'
        ? `zstdcat "${dumpFilePath}"`
        : ext === '.gz'
        ? `gzip -dc "${dumpFilePath}"`
        : `cat "${dumpFilePath}"`;

    const sshArgs = buildSshBaseArgs(targetServer)
      .map((a) => (a.includes(' ') ? `"${a}"` : a))
      .join(' ');

    const remoteMysqlCmd = `mysql ${authFlags} "${targetDbName}"`;
    const pipeline = `set -o pipefail; ${decompCmd} | ssh ${sshArgs} ${
      targetServer.ssh_user || 'root'
    }@${targetServer.ip_address} ${shellSingleQuote(remoteMysqlCmd)}`;

    const child = spawn('bash', ['-c', pipeline], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
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
 * Mục 8: Cơ chế Khôi phục Đa năng (Files Only / DB Only / Cross-Panel Migration)
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
  const targetServer = db
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
    const targetDomain = (payload.targetDomainName || item.domain_name).trim();
    const targetUser = (payload.targetSystemUser || item.system_user).trim();
    const targetAdapter = getPanelAdapter(targetServer);

    const resolvedWebroot =
      payload.targetWebrootOverride?.trim() ||
      (await targetAdapter.resolveTargetWebroot(
        targetServer,
        targetUser,
        targetDomain
      ));

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
    if (!isCrossPanel && fs.existsSync(metadataPath)) {
      try {
        const meta = JSON.parse(
          fs.readFileSync(metadataPath, 'utf8')
        ) as DomainMetadataJson;
        if (Array.isArray(meta.excluded_subpaths)) {
          savedExcludedSubpaths = meta.excluded_subpaths;
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

    // 1. Khôi phục Mã nguồn (Files)
    if (payload.mode === 'FILES_ONLY' || payload.mode === 'FULL') {
      if (!fs.existsSync(localPublicHtml)) {
        throw new Error(
          `Không tìm thấy thư mục mã nguồn tại ${localPublicHtml}`
        );
      }

      setStep(20, `Đang đẩy mã nguồn lên ${resolvedWebroot}...`);
      appendLog(
        `[Files Restore] Nguồn NAS: ${localPublicHtml} ➔ Đích VPS: ${targetServer.hostname}:${resolvedWebroot}`
      );

      const permCmd = targetAdapter.buildPermissionFixCommand(
        targetUser,
        targetDomain,
        resolvedWebroot
      );

      if (targetServer.is_mock) {
        await new Promise((r) => setTimeout(r, 450));
        const mockRestoreDest = path.join(
          getDataDir(),
          'restored_preview',
          targetServer.hostname,
          targetDomain,
          'public_html'
        );
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

        for (let i = 0; i < dbsToRestore.length; i++) {
          const dbInfo = dbsToRestore[i];
          const targetDbName =
            payload.targetDbMap?.[dbInfo.name]?.trim() || dbInfo.name;
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
            await execRemoteSSH(
              targetServer,
              `mysql ${authFlags} -e "CREATE DATABASE IF NOT EXISTS \\\`${targetDbName}\\\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`,
              { zeroImpact: true }
            );
            await streamRestoreDatabaseOverSsh({
              targetServer,
              authFlags,
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
    const errMsg = (err as Error).message;
    appendLog(`❌ Khôi phục thất bại: ${errMsg}`);
    db.prepare(
      `UPDATE backup_jobs
       SET status = 'FAILED', current_phase = 'Khôi phục thất bại', completed_at = datetime('now'), error_log = ?
       WHERE id = ?`
    ).run(errMsg, jobId);

    await createSystemAlert({
      severity: 'CRITICAL',
      category: 'RESTORE',
      title: `Khôi phục thất bại cho ${item.domain_name}`,
      message: errMsg,
      serverId: targetServer.id,
      jobId,
    });

    emitJobUpdated(jobId);
    throw err;
  }
}


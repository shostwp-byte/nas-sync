import { getSetting } from '@/lib/db';
import { createSystemAlert } from '@/lib/notifications';

export interface BtrfsSnapshotResult {
  ok: boolean;
  simulated?: boolean;
  sharesProcessed: string[];
  retentionDays: number;
  message: string;
}

/**
 * Mục 9.1: Chống Ransomware bằng Btrfs Immutable Snapshot (WORM) trên Synology DSM
 * Gọi API của Synology DSM (SYNO.API.Auth -> SYNO.Core.Share.Snapshot) để tạo bản chụp
 * Btrfs khóa cứng chống xóa/ghi đè (Immutable WORM) trong N ngày (Mặc định 7 ngày).
 */
export async function triggerSynologyBtrfsImmutableSnapshot(
  retentionDays = 7
): Promise<BtrfsSnapshotResult> {
  const dsmUrl = getSetting('dsm_api_url').replace(/\/+$/, '');
  const username = getSetting('dsm_username');
  const password = getSetting('dsm_password');
  const sharesRaw = getSetting('dsm_backup_shares', 'VPS_Backups');
  const shares = sharesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!dsmUrl || !username || !password) {
    const msg = `Đã ghi nhận yêu cầu chụp Btrfs Immutable Snapshot (WORM ${retentionDays} ngày) cho Shared Folder [${shares.join(
      ', '
    )}] (Chế độ mô phỏng — Chưa cấu hình DSM_API_URL / tài khoản DSM trong mục Cài đặt).`;

    await createSystemAlert({
      severity: 'INFO',
      category: 'BTRFS',
      title: `Btrfs Immutable Snapshot (Mô phỏng WORM ${retentionDays} ngày)`,
      message: msg,
      notifyExternal: false,
    });

    return {
      ok: true,
      simulated: true,
      sharesProcessed: shares,
      retentionDays,
      message: msg,
    };
  }

  try {
    // Bước 1: Xác thực Synology DSM WebAPI (SYNO.API.Auth)
    const authParams = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: username,
      passwd: password,
      session: 'ShostBackupWORM',
      format: 'sid',
    });

    const authResp = await fetch(`${dsmUrl}/webapi/auth.cgi?${authParams.toString()}`);
    const authJson = (await authResp.json()) as {
      success?: boolean;
      data?: { sid?: string };
      error?: { code?: number };
    };

    if (!authJson.success || !authJson.data?.sid) {
      throw new Error(
        `Đăng nhập Synology DSM API thất bại (Mã lỗi: ${
          authJson.error?.code ?? 'unknown'
        })`
      );
    }

    const sid = authJson.data.sid;
    const processed: string[] = [];

    try {
      // Bước 2: Gọi tạo Btrfs Immutable Snapshot (WORM) cho từng Shared Folder chứa Backup
      for (const share of shares) {
        const snapParams = new URLSearchParams({
          api: 'SYNO.Core.Share.Snapshot',
          version: '2',
          method: 'create',
          name: share,
          desc: `SHOST Backup Auto Immutable WORM (${retentionDays}d)`,
          is_locked: 'true',
          immutable: 'true',
          immutable_days: String(retentionDays),
          _sid: sid,
        });

        const snapResp = await fetch(
          `${dsmUrl}/webapi/entry.cgi?${snapParams.toString()}`
        );
        const snapJson = (await snapResp.json()) as {
          success?: boolean;
          error?: { code?: number };
        };

        if (!snapJson.success) {
          throw new Error(
            `Tạo Immutable Snapshot trên Share "${share}" thất bại (DSM Error ${
              snapJson.error?.code ?? 'unknown'
            })`
          );
        }
        processed.push(share);
      }
    } finally {
      // Bước 3: Đăng xuất phiên DSM API
      const logoutParams = new URLSearchParams({
        api: 'SYNO.API.Auth',
        version: '6',
        method: 'logout',
        session: 'ShostBackupWORM',
        _sid: sid,
      });
      await fetch(`${dsmUrl}/webapi/auth.cgi?${logoutParams.toString()}`).catch(
        () => {}
      );
    }

    const successMsg = `Đã khóa Btrfs Immutable Snapshot (WORM ${retentionDays} ngày chống Ransomware) thành công cho Shared Folder: ${processed.join(
      ', '
    )}.`;

    await createSystemAlert({
      severity: 'INFO',
      category: 'BTRFS',
      title: `Đã tạo Btrfs Immutable Snapshot (${retentionDays} ngày WORM)`,
      message: successMsg,
      notifyExternal: false,
    });

    return {
      ok: true,
      sharesProcessed: processed,
      retentionDays,
      message: successMsg,
    };
  } catch (err) {
    const errMsg = `Lỗi gọi Synology DSM Btrfs Snapshot API: ${(err as Error).message}`;
    await createSystemAlert({
      severity: 'WARNING',
      category: 'BTRFS',
      title: 'Không thể tạo Btrfs Immutable Snapshot trên DSM',
      message: errMsg,
    });
    return {
      ok: false,
      sharesProcessed: [],
      retentionDays,
      message: errMsg,
    };
  }
}


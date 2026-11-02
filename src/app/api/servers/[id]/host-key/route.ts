import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  computeOpenSshKeyFingerprint,
  ensureServerHostKeyPinned,
  removeServerKnownHostsCache,
} from '@/lib/ssh';
import type { HostKeyStatus, ServerRecord } from '@/types';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const { id } = await params;
    const serverId = Number(id);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '').trim();

    if (action !== 'approve_new' && action !== 'reset_tofu') {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Hành động không hợp lệ (chỉ chấp nhận "approve_new" hoặc "reset_tofu").',
        },
        { status: 400 }
      );
    }

    const db = getDb();
    const server = db
      .prepare('SELECT * FROM servers WHERE id = ?')
      .get(serverId) as unknown as ServerRecord | undefined;

    if (!server) {
      return NextResponse.json(
        { ok: false, error: 'Không tìm thấy máy chủ VPS.' },
        { status: 404 }
      );
    }

    if (action === 'approve_new') {
      const pendingEntry = (server.host_key_pending_entry || '').trim();
      if (pendingEntry) {
        const firstLine = pendingEntry
          .split(/\r?\n/)
          .find((l) => l.trim() && !l.trim().startsWith('#'));
        const promotedFingerprint =
          (server.host_key_pending_fingerprint || '').trim() ||
          (firstLine ? computeOpenSshKeyFingerprint(firstLine) : '');

        db.prepare(
          `UPDATE servers
           SET known_host_entry = ?,
               host_key_fingerprint = ?,
               host_key_status = 'VERIFIED',
               host_key_pending_fingerprint = '',
               host_key_pending_entry = '',
               status = 'ONLINE'
           WHERE id = ?`
        ).run(pendingEntry, promotedFingerprint, serverId);
        removeServerKnownHostsCache(serverId);

        recordAuditLog({
          session: guard.session,
          action: 'SERVER_APPROVE_HOST_KEY',
          resourceType: 'SERVER',
          resourceId: String(serverId),
          detail: `Xác nhận và ghim SSH Host Key mới cho "${server.hostname}" (${promotedFingerprint})`,
          req,
        });

        return NextResponse.json({
          ok: true,
          host_key_status: 'VERIFIED' as HostKeyStatus,
          host_key_fingerprint: promotedFingerprint,
        });
      }

      // Không có pending entry: đặt lại TOFU và quét tươi ngay lập tức
      db.prepare(
        `UPDATE servers
         SET known_host_entry = '',
             host_key_fingerprint = '',
             host_key_status = 'UNPINNED',
             host_key_pending_fingerprint = '',
             host_key_pending_entry = ''
         WHERE id = ?`
      ).run(serverId);
      removeServerKnownHostsCache(serverId);

      let nextStatus: HostKeyStatus = 'UNPINNED';
      let nextFp = '';
      try {
        const pinned = await ensureServerHostKeyPinned(serverId);
        nextStatus = pinned.status;
        nextFp = pinned.fingerprint;
        db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
          serverId
        );
      } catch {
        // Giữ trạng thái UNPINNED nếu máy chủ hiện đang ngoại tuyến
      }

      recordAuditLog({
        session: guard.session,
        action: 'SERVER_APPROVE_HOST_KEY',
        resourceType: 'SERVER',
        resourceId: String(serverId),
        detail: `Quét và ghim mới SSH Host Key cho "${server.hostname}" (${nextStatus}${
          nextFp ? `: ${nextFp}` : ''
        })`,
        req,
      });

      return NextResponse.json({
        ok: true,
        host_key_status: nextStatus,
        host_key_fingerprint: nextFp,
      });
    }

    // action === 'reset_tofu'
    db.prepare(
      `UPDATE servers
       SET known_host_entry = '',
           host_key_fingerprint = '',
           host_key_status = 'UNPINNED',
           host_key_pending_fingerprint = '',
           host_key_pending_entry = ''
       WHERE id = ?`
    ).run(serverId);
    removeServerKnownHostsCache(serverId);

    let nextStatus: HostKeyStatus = 'UNPINNED';
    let nextFp = '';
    try {
      const pinned = await ensureServerHostKeyPinned(serverId);
      nextStatus = pinned.status;
      nextFp = pinned.fingerprint;
      if (server.status === 'ERROR') {
        db.prepare(`UPDATE servers SET status = 'ONLINE' WHERE id = ?`).run(
          serverId
        );
      }
    } catch {
      // Nếu VPS ngoại tuyến, giữ UNPINNED để tự động ghim ở lần kết nối kế tiếp
    }

    recordAuditLog({
      session: guard.session,
      action: 'SERVER_RESET_HOST_KEY',
      resourceType: 'SERVER',
      resourceId: String(serverId),
      detail: `Đặt lại khóa định danh TOFU SSH Host Key cho "${server.hostname}" ➔ ${nextStatus}${
        nextFp ? ` (${nextFp})` : ''
      }`,
      req,
    });

    return NextResponse.json({
      ok: true,
      host_key_status: nextStatus,
      host_key_fingerprint: nextFp,
    });
  } catch (err) {
    return safeErrorJson(
      err,
      'Không thể xử lý yêu cầu quản lý SSH Host Key.'
    );
  }
}

import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { resolveValidatedSshKeyPath } from '@/lib/ssh';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const keyId = Number(id);
  const db = getDb();
  const row = db
    .prepare('SELECT name, private_key_path FROM ssh_keys WHERE id = ?')
    .get(keyId);

  if (row?.private_key_path) {
    try {
      const safePath = resolveValidatedSshKeyPath(String(row.private_key_path));
      fs.rmSync(safePath, { force: true });
      fs.rmSync(`${safePath}.pub`, { force: true });
    } catch {
      // Bỏ qua xóa file trên ổ đĩa nếu đường dẫn không nằm trong vùng SSH_KEYS_DIR hợp lệ
    }
  }

  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(keyId);

  if (row) {
    recordAuditLog({
      session: guard.session,
      action: 'SSH_KEY_DELETE',
      resourceType: 'SSH_KEY',
      resourceId: String(keyId),
      detail: `Xóa khóa SSH "${row.name}"`,
      req,
    });
  }

  return NextResponse.json({ ok: true });
}

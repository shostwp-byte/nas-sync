import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { resolveValidatedSshKeyPath } from '@/lib/ssh';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare('SELECT private_key_path FROM ssh_keys WHERE id = ?')
    .get(Number(id));
  if (row?.private_key_path) {
    try {
      const safePath = resolveValidatedSshKeyPath(String(row.private_key_path));
      fs.rmSync(safePath, { force: true });
      fs.rmSync(`${safePath}.pub`, { force: true });
    } catch {
      // Bỏ qua xóa file trên ổ đĩa nếu đường dẫn không nằm trong vùng SSH_KEYS_DIR hợp lệ
    }
  }
  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(Number(id));
  return NextResponse.json({ ok: true });
}


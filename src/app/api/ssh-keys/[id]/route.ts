import fs from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

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
    const p = String(row.private_key_path);
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.pub`, { force: true });
  }
  db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(Number(id));
  return NextResponse.json({ ok: true });
}


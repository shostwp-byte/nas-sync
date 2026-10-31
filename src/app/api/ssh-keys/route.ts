import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb, getSshKeysDir } from '@/lib/db';
import { generateSshKeyPair } from '@/lib/ssh';

export async function GET() {
  const keys = getDb()
    .prepare('SELECT * FROM ssh_keys ORDER BY id DESC')
    .all();
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const mode = String(body.mode || 'generate');
    const name = String(body.name || '').trim();

    if (!name) {
      return NextResponse.json(
        { error: 'Vui lòng nhập tên định danh cho SSH Key.' },
        { status: 400 }
      );
    }

    const db = getDb();

    if (mode === 'import') {
      const privateKeyContent = String(body.privateKey || '').trim();
      const publicKeyContent = String(body.publicKey || '').trim();
      if (!privateKeyContent) {
        return NextResponse.json(
          { error: 'Vui lòng dán nội dung Private Key.' },
          { status: 400 }
        );
      }
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      const privPath = path.join(getSshKeysDir(), safeName);
      // SSH_KEYS_DIR là /root/.ssh trong container — không cho ghi đè file sẵn có
      // (authorized_keys, known_hosts, config, khóa đang dùng cho máy chủ khác...)
      if (fs.existsSync(privPath)) {
        return NextResponse.json(
          { error: `Đã tồn tại file "${safeName}" trong thư mục SSH Keys. Vui lòng chọn tên khác.` },
          { status: 400 }
        );
      }
      fs.writeFileSync(privPath, privateKeyContent + '\n', { mode: 0o600 });
      if (publicKeyContent) {
        fs.writeFileSync(`${privPath}.pub`, publicKeyContent + '\n', {
          mode: 0o644,
        });
      }
      db.prepare(
        `INSERT INTO ssh_keys (name, key_type, private_key_path, public_key, fingerprint)
         VALUES (?, 'imported', ?, ?, 'Imported Private Key')`
      ).run(name, privPath, publicKeyContent || '(Imported Private Key)');
    } else {
      const keyType = body.keyType === 'rsa' ? 'rsa' : 'ed25519';
      const generated = await generateSshKeyPair(name, keyType);
      db.prepare(
        `INSERT INTO ssh_keys (name, key_type, private_key_path, public_key, fingerprint)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        name,
        keyType,
        generated.privateKeyPath,
        generated.publicKey,
        generated.fingerprint
      );
    }

    const keys = db
      .prepare('SELECT * FROM ssh_keys ORDER BY id DESC')
      .all();
    return NextResponse.json({ ok: true, keys });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 }
    );
  }
}


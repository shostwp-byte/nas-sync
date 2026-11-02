import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { getDb, getSshKeysDir } from '@/lib/db';
import {
  execLocalCommand,
  generateSshKeyPair,
  validateSafeSshKeyName,
} from '@/lib/ssh';

const MAX_PRIVATE_KEY_BYTES = 32768;
const MAX_PUBLIC_KEY_BYTES = 8192;
const VALID_SSH_PUBKEY_PREFIXES = [
  'ssh-ed25519 ',
  'ssh-rsa ',
  'ecdsa-sha2-',
  'sk-ssh-',
  'sk-ecdsa-sha2-',
];

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
    const rawName = String(body.name || '').trim();

    if (!rawName) {
      return NextResponse.json(
        { error: 'Vui lòng nhập tên định danh cho SSH Key.' },
        { status: 400 }
      );
    }

    let safeName: string;
    try {
      safeName = validateSafeSshKeyName(rawName);
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 400 }
      );
    }

    const db = getDb();

    if (mode === 'import') {
      const privateKeyContent = String(body.privateKey || '')
        .replace(/\r\n/g, '\n')
        .trim();
      const publicKeyInput = String(body.publicKey || '').trim();

      if (!privateKeyContent) {
        return NextResponse.json(
          { error: 'Vui lòng dán nội dung Private Key.' },
          { status: 400 }
        );
      }

      if (
        Buffer.byteLength(privateKeyContent, 'utf8') > MAX_PRIVATE_KEY_BYTES ||
        !privateKeyContent.startsWith('-----BEGIN ') ||
        !privateKeyContent.includes('PRIVATE KEY-----') ||
        privateKeyContent.includes('\0')
      ) {
        return NextResponse.json(
          {
            error:
              'Định dạng Private Key không hợp lệ (phải là PEM/OpenSSH Private Key và dung lượng tối đa 32 KB).',
          },
          { status: 400 }
        );
      }

      if (publicKeyInput) {
        const hasValidPrefix = VALID_SSH_PUBKEY_PREFIXES.some((prefix) =>
          publicKeyInput.startsWith(prefix)
        );
        const hasUnsafeChars =
          /[\r\n\0`$"\\;|&<>]/.test(publicKeyInput) ||
          Buffer.byteLength(publicKeyInput, 'utf8') > MAX_PUBLIC_KEY_BYTES;

        if (!hasValidPrefix || hasUnsafeChars) {
          return NextResponse.json(
            {
              error:
                'Định dạng Public Key không hợp lệ (phải trên một dòng, bắt đầu bằng kiểu khóa SSH chuẩn và không chứa ký tự shell nguy hiểm).',
            },
            { status: 400 }
          );
        }
      }

      const keysDir = path.resolve(getSshKeysDir());
      const privPath = path.join(keysDir, safeName);
      const pubPath = `${privPath}.pub`;

      // SSH_KEYS_DIR có thể là /root/.ssh trong container — tuyệt đối không ghi đè file sẵn có
      if (fs.existsSync(privPath) || fs.existsSync(pubPath)) {
        return NextResponse.json(
          {
            error: `Đã tồn tại file "${safeName}" trong thư mục SSH Keys. Vui lòng chọn tên khác.`,
          },
          { status: 400 }
        );
      }

      fs.writeFileSync(privPath, privateKeyContent + '\n', { mode: 0o600 });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(privPath, 0o600);
        } catch {
          // Ignore on Windows/RichACL mounts
        }
      }

      // Kiểm định tính hợp lệ thực sự của khóa bằng ssh-keygen & tự trích xuất Public Key nếu để trống
      const derivedPubRes = await execLocalCommand(
        'ssh-keygen',
        ['-P', '', '-y', '-f', privPath],
        10000
      );
      if (derivedPubRes.code !== 0 || !derivedPubRes.stdout.trim()) {
        fs.rmSync(privPath, { force: true });
        fs.rmSync(pubPath, { force: true });
        return NextResponse.json(
          {
            error:
              'Khóa SSH không hợp lệ, bị hỏng hoặc đang đặt mật khẩu bảo vệ (Passphrase). Vui lòng nhập khóa SSH hợp lệ không có Passphrase.',
          },
          { status: 400 }
        );
      }

      const finalPublicKey = publicKeyInput || derivedPubRes.stdout.trim();
      fs.writeFileSync(pubPath, finalPublicKey + '\n', { mode: 0o644 });
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(pubPath, 0o644);
        } catch {
          // Ignore
        }
      }

      const fpRes = await execLocalCommand(
        'ssh-keygen',
        ['-lf', pubPath],
        10000
      );
      const fingerprint = fpRes.code === 0 ? fpRes.stdout.trim() : '';
      if (!fingerprint || fingerprint === 'N/A') {
        fs.rmSync(privPath, { force: true });
        fs.rmSync(pubPath, { force: true });
        return NextResponse.json(
          { error: 'Khóa SSH không hợp lệ hoặc bị hỏng.' },
          { status: 400 }
        );
      }

      db.prepare(
        `INSERT INTO ssh_keys (name, key_type, private_key_path, public_key, fingerprint)
         VALUES (?, 'imported', ?, ?, ?)`
      ).run(safeName, privPath, finalPublicKey, fingerprint);
    } else {
      const keyType = body.keyType === 'rsa' ? 'rsa' : 'ed25519';
      const generated = await generateSshKeyPair(safeName, keyType);
      db.prepare(
        `INSERT INTO ssh_keys (name, key_type, private_key_path, public_key, fingerprint)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        safeName,
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


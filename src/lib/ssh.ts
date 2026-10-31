import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerRecord } from '@/types';
import { getDb, getSshKeysDir } from './db';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Bọc câu lệnh trên VPS bằng ionice và nice để đảm bảo Zero-Impact Backup (Mục 5.1)
 * Nếu hệ điều hành VPS container (OpenVZ/LXC) không có ionice thì tự động fallback sang nice -n 19.
 */
export function wrapZeroImpact(remoteCommand: string): string {
  return `(command -v ionice >/dev/null 2>&1 && ionice -c 2 -n 7 nice -n 19 sh -c ${shellSingleQuote(
    remoteCommand
  )} || nice -n 19 sh -c ${shellSingleQuote(remoteCommand)})`;
}

export function shellSingleQuote(str: string): string {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function resolveServerKeyPath(server: ServerRecord): string | null {
  let candidate = (server.ssh_key_path || '').trim();
  if (!candidate) {
    try {
      const latestKey = getDb()
        .prepare(
          'SELECT private_key_path FROM ssh_keys ORDER BY id DESC LIMIT 1'
        )
        .get() as { private_key_path?: string } | undefined;
      if (latestKey?.private_key_path) {
        candidate = latestKey.private_key_path.trim();
      }
    } catch {
      // Bỏ qua nếu CSDL chưa khởi tạo
    }
  }

  if (!candidate || !fs.existsSync(candidate)) {
    return null;
  }

  if (process.platform === 'win32') {
    return candidate;
  }

  try {
    fs.chmodSync(candidate, 0o600);
  } catch {
    // Bỏ qua trên mount chỉ đọc hoặc có Synology RichACL
  }

  try {
    const stat = fs.statSync(candidate);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    if ((stat.mode & 0o077) === 0 && stat.uid === currentUid) {
      return candidate;
    }

    // Nếu thư mục bind-mount trên Synology Btrfs dính Windows ACL (0777 hoặc UID 1026),
    // sao chép sang tmpfs nội bộ container với chuẩn quyền 0600 để OpenSSH không từ chối key
    const safeDir = path.join(os.tmpdir(), '.nas_sync_ssh_keys');
    fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(safeDir, 0o700);
    const stagedPath = path.join(safeDir, path.basename(candidate));
    fs.copyFileSync(candidate, stagedPath);
    fs.chmodSync(stagedPath, 0o600);
    return stagedPath;
  } catch {
    return candidate;
  }
}

export function buildSshBaseArgs(server: ServerRecord): string[] {
  const args: string[] = [
    '-p',
    String(server.ssh_port || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'IgnoreUnknown=WarnWeakCrypto,PubkeyAcceptedAlgorithms,HostKeyAlgorithms',
    '-o',
    'WarnWeakCrypto=no',
    '-o',
    'PubkeyAcceptedAlgorithms=+ssh-rsa',
    '-o',
    'HostKeyAlgorithms=+ssh-rsa',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
  ];

  const resolvedKey = resolveServerKeyPath(server);
  if (resolvedKey) {
    args.push('-i', resolvedKey);
  }

  return args;
}

export function buildRsyncSshTransport(server: ServerRecord): string {
  const resolvedKey = resolveServerKeyPath(server);
  const keyPart = resolvedKey ? `-i "${resolvedKey}" ` : '';
  return `ssh ${keyPart}-p ${
    server.ssh_port || 22
  } -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o IgnoreUnknown=WarnWeakCrypto,PubkeyAcceptedAlgorithms,HostKeyAlgorithms -o WarnWeakCrypto=no -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o Compression=no`;
}

export function execLocalCommand(
  cmd: string,
  args: string[],
  timeoutMs = 120000
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({
          code: code ?? 1,
          stdout,
          stderr,
        });
      }
    });
  });
}

export async function execRemoteSSH(
  server: ServerRecord,
  remoteCommand: string,
  options: { zeroImpact?: boolean; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const finalCmd = options.zeroImpact
    ? wrapZeroImpact(remoteCommand)
    : remoteCommand;

  const args = [
    ...buildSshBaseArgs(server),
    `${server.ssh_user || 'root'}@${server.ip_address}`,
    finalCmd,
  ];

  return execLocalCommand('ssh', args, options.timeoutMs ?? 60000);
}

export async function testSshConnection(server: ServerRecord): Promise<{
  ok: boolean;
  osInfo?: string;
  uptime?: string;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  if (server.is_mock) {
    await new Promise((r) => setTimeout(r, 250));
    return {
      ok: true,
      osInfo: 'AlmaLinux 9.4 (Mock Simulation Mode)',
      uptime: 'up 84 days, 12:40',
      latencyMs: Date.now() - start,
    };
  }

  try {
    const res = await execRemoteSSH(
      server,
      'uname -sr && (uptime -p 2>/dev/null || uptime)',
      { timeoutMs: 15000 }
    );
    if (res.code !== 0) {
      const cleanedStderr = res.stderr
        .split('\n')
        .filter((line) => !line.trim().startsWith('** '))
        .join('\n')
        .trim();
      let errorMsg = cleanedStderr || res.stderr.trim() || `SSH exited with code ${res.code}`;
      if (errorMsg.includes('Permission denied')) {
        const keyUsed = resolveServerKeyPath(server);
        errorMsg += keyUsed
          ? ` — Đã thử khóa "${server.ssh_key_path || keyUsed}". Hãy đảm bảo bạn đã dán Public Key của khóa này vào ~/.ssh/authorized_keys trên VPS.`
          : ' — Máy chủ này chưa được gán SSH Key! Hãy bấm "Quản lý SSH Keys" -> "+ Sinh Khóa SSH Mới" và dán lệnh cài Public Key lên VPS.';
      }
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: errorMsg,
      };
    }
    const lines = res.stdout.trim().split('\n');
    return {
      ok: true,
      osInfo: lines[0] || 'Linux',
      uptime: lines[1] || '',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

export async function generateSshKeyPair(
  keyName: string,
  keyType: 'ed25519' | 'rsa' = 'ed25519'
): Promise<{
  privateKeyPath: string;
  publicKey: string;
  fingerprint: string;
}> {
  const safeName = keyName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const keysDir = getSshKeysDir();
  const privateKeyPath = path.join(keysDir, safeName);
  const pubKeyPath = `${privateKeyPath}.pub`;

  if (fs.existsSync(privateKeyPath)) {
    throw new Error(`Khóa SSH "${safeName}" đã tồn tại tại ${privateKeyPath}`);
  }

  const args =
    keyType === 'rsa'
      ? ['-t', 'rsa', '-b', '4096', '-N', '', '-C', `nas-sync-${safeName}`, '-f', privateKeyPath]
      : ['-t', 'ed25519', '-N', '', '-C', `nas-sync-${safeName}`, '-f', privateKeyPath];

  const res = await execLocalCommand('ssh-keygen', args, 20000);
  if (res.code !== 0) {
    throw new Error(`Không thể tạo SSH key: ${res.stderr || res.stdout}`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(pubKeyPath, 0o644);
  }

  const publicKey = fs.readFileSync(pubKeyPath, 'utf8').trim();
  const fpRes = await execLocalCommand('ssh-keygen', ['-lf', pubKeyPath], 10000);
  const fingerprint = fpRes.code === 0 ? fpRes.stdout.trim() : '';

  return {
    privateKeyPath,
    publicKey,
    fingerprint,
  };
}


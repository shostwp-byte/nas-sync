import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import {
  resolveSafeSnapshotRoot,
  resolveSafeSubPath,
} from '@/lib/engine/explorer';
import { isSafeDomain } from '@/lib/engine/safe-names';

export async function GET(req: NextRequest) {
  try {
    const guard = await requireRole(
      ['ADMIN', 'OPERATOR'],
      'Tài khoản VIEWER không có quyền tải xuống dữ liệu sao lưu.'
    );
    if (!guard.ok) return guard.response;

    const sp = req.nextUrl.searchParams;
    const jobId = Number(sp.get('jobId'));
    const domain = (sp.get('domain') || '').trim();
    const relPath = (sp.get('path') || '').trim();

    if (!Number.isInteger(jobId) || jobId <= 0) {
      return NextResponse.json(
        { error: 'Thiếu hoặc sai tham số jobId.' },
        { status: 400 }
      );
    }

    let effectiveRelPath = '';
    if (domain) {
      if (!isSafeDomain(domain)) {
        return NextResponse.json(
          { error: 'Tên miền yêu cầu đóng gói không hợp lệ.' },
          { status: 400 }
        );
      }
      effectiveRelPath = `home/domains/${domain}`;
    } else {
      effectiveRelPath = relPath;
    }

    const { snapshotRoot, hostname, snapshotName } =
      resolveSafeSnapshotRoot(jobId);
    const targetPath = resolveSafeSubPath(snapshotRoot, effectiveRelPath);

    if (!fs.existsSync(targetPath)) {
      return NextResponse.json(
        { error: 'Thư mục hoặc tập tin sao lưu không tồn tại trong Snapshot này.' },
        { status: 404 }
      );
    }

    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      return NextResponse.json(
        {
          error:
            'Đối tượng tải xuống không hợp lệ (từ chối symlink, FIFO hoặc thiết bị đặc biệt).',
        },
        { status: 400 }
      );
    }

    const downloadFileName = domain
      ? `${domain}_${snapshotName}.tar.gz`
      : !effectiveRelPath
      ? `${hostname}_${snapshotName}.tar.gz`
      : `${path.basename(targetPath)}_${snapshotName}.tar.gz`;

    const parentDir = path.dirname(targetPath);
    const rawEntryName = path.basename(targetPath);
    const entryName = rawEntryName.startsWith('-')
      ? `./${rawEntryName}`
      : rawEntryName;

    const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar';
    const tarArgs = [
      '--exclude=.rsync-partial',
      '--exclude=.state.json',
      '-czf',
      '-',
      '-C',
      parentDir,
      entryName,
    ];

    const child = spawn(tarBin, tarArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let aborted = false;
    let stderr = '';
    let stdoutEnded = false;
    let processClosed = false;
    let exitCode: number | null = null;

    const killTarProcess = () => {
      if (aborted) return;
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      const forceKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null) {
            child.kill('SIGKILL');
          }
        } catch {
          // Ignore
        }
      }, 3000);
      forceKillTimer.unref();
    };

    req.signal.addEventListener('abort', killTarProcess, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        const tryFinalize = () => {
          if (aborted) return;
          if (!stdoutEnded || !processClosed) return;
          if (exitCode === 0) {
            try {
              controller.close();
            } catch {
              // Ignore if already closed
            }
          } else {
            try {
              controller.error(
                new Error(
                  `Đóng gói luồng .tar.gz thất bại (code ${exitCode}): ${stderr.trim()}`
                )
              );
            } catch {
              // Ignore
            }
          }
        };

        child.stdout.on('data', (chunk: Buffer) => {
          if (aborted) return;
          try {
            controller.enqueue(new Uint8Array(chunk));
          } catch {
            killTarProcess();
          }
        });

        child.stdout.on('end', () => {
          stdoutEnded = true;
          tryFinalize();
        });

        child.on('error', (err) => {
          if (aborted) return;
          try {
            controller.error(err);
          } catch {
            // Ignore
          }
        });

        child.on('close', (code) => {
          processClosed = true;
          exitCode = code ?? 1;
          tryFinalize();
        });
      },
      cancel() {
        killTarProcess();
      },
    });

    recordAuditLog({
      session: guard.session,
      action: 'DOWNLOAD_ARCHIVE',
      resourceType: 'SNAPSHOT',
      resourceId: String(jobId),
      detail: `Tải gói nén .tar.gz (${
        domain || effectiveRelPath || 'full-snapshot'
      }) từ ${hostname}@${snapshotName}`,
      req,
    });

    return new NextResponse(webStream, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(
          downloadFileName
        )}`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 }
    );
  }
}

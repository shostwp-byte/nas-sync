import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { requireRole } from '@/lib/auth';
import {
  resolveSafeSnapshotRoot,
  resolveSafeSubPath,
} from '@/lib/engine/explorer';
import { isSafeDomain } from '@/lib/engine/safe-names';
import { acquireSnapshotReadPin } from '@/lib/engine/snapshot-pins';
import {
  DETACHED_PROCESS_GROUP,
  terminateChildGracefully,
} from '@/lib/engine/worker-state';

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

    const { serverId, snapshotRoot, hostname, snapshotName } =
      resolveSafeSnapshotRoot(jobId);
    const targetPath = resolveSafeSubPath(snapshotRoot, effectiveRelPath);

    if (!fs.existsSync(targetPath)) {
      return NextResponse.json(
        {
          error:
            'Thư mục hoặc tập tin sao lưu không tồn tại trong Snapshot này.',
        },
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
      '-czf',
      '-',
      '--exclude=.rsync-partial',
      '--exclude=.state.json',
      '-C',
      parentDir,
      entryName,
    ];

    // Ghim đọc Snapshot để ngăn GFS Retention / xóa tay dọn mất thư mục khi đang stream tải về
    const releasePin = acquireSnapshotReadPin(serverId, snapshotName);
    let pinReleased = false;
    const releasePinOnce = () => {
      if (pinReleased) return;
      pinReleased = true;
      releasePin();
    };

    const child = spawn(tarBin, tarArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: DETACHED_PROCESS_GROUP,
    });

    let aborted = false;
    let stderr = '';
    let stdoutEnded = false;
    let processClosed = false;
    let exitCode: number | null = null;

    const killTarProcess = () => {
      if (aborted) return;
      aborted = true;
      releasePinOnce();
      terminateChildGracefully(child);
    };

    req.signal.addEventListener('abort', killTarProcess, { once: true });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });

    // N3 Fix: Áp dụng Backpressure thực sự (pause/resume theo controller.desiredSize + pull())
    // chống phình bộ nhớ V8 Heap khi client tải chậm với snapshot hàng chục GB!
    const webStream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          child.stdout.pause();

          const tryFinalize = () => {
            if (aborted) return;
            if (!stdoutEnded || !processClosed) return;
            releasePinOnce();
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
              if (
                controller.desiredSize !== null &&
                controller.desiredSize <= 0
              ) {
                child.stdout.pause();
              }
            } catch {
              killTarProcess();
            }
          });

          child.stdout.on('end', () => {
            stdoutEnded = true;
            tryFinalize();
          });

          child.on('error', (err) => {
            releasePinOnce();
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
            if (aborted) {
              releasePinOnce();
              return;
            }
            tryFinalize();
          });
        },
        pull() {
          if (!aborted && !stdoutEnded) {
            child.stdout.resume();
          }
        },
        cancel() {
          killTarProcess();
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 })
    );

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
    return safeErrorJson(
      err,
      'Không thể đóng gói dữ liệu tải xuống.',
      400
    );
  }
}

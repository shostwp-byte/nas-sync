import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  buildRsyncSshTransport,
  buildSshBaseArgs,
  execRemoteSSH,
  shellSingleQuote,
} from '@/lib/ssh';
import type { DiscoveredDomain, PanelType, ServerRecord } from '@/types';
import { buildJailedRsyncPath } from './adapters/base';
import { getDirectorySizeAndCount, parseRsyncStats } from './rsync-runner';
import { assertSafe, isSafeDomain, isSafeSystemUser } from './safe-names';
import {
  DETACHED_PROCESS_GROUP,
  RetryableNetworkError,
  STREAM_IDLE_TIMEOUT_MS,
  isJobCancelled,
  registerJobChildProcess,
  terminateChildGracefully,
  throwIfCancelled,
} from './worker-state';

const MAX_VHOST_FILE_BYTES = 256 * 1024; // 256 KB per file
const MAX_VHOST_ARCHIVE_UNCOMPRESSED_BYTES = 16 * 1024 * 1024; // 16 MB total cap

function buildMailboxCandidates(
  panelType: PanelType,
  systemUser: string,
  domain: string
): string[] {
  switch (panelType) {
    case 'DIRECTADMIN':
      return [`/home/${systemUser}/imap/${domain}`];
    case 'CPANEL':
    case 'HESTIACP':
      return [`/home/${systemUser}/mail/${domain}`];
    case 'PLESK':
      return [`/var/qmail/mailnames/${domain}`];
    case 'CYBERPANEL':
    case 'AAPANEL':
    case 'CLOUDPANEL':
      return [`/home/vmail/${domain}`, `/www/vmail/${domain}`];
  }
}

function buildVhostCandidateFiles(
  panelType: PanelType,
  systemUser: string,
  domain: string
): string[] {
  switch (panelType) {
    case 'DIRECTADMIN':
      return [
        `/usr/local/directadmin/data/users/${systemUser}/domains/${domain}.conf`,
        `/usr/local/directadmin/data/users/${systemUser}/domains/${domain}.ssl`,
        `/usr/local/directadmin/data/users/${systemUser}/httpd.conf`,
        `/usr/local/directadmin/data/users/${systemUser}/nginx.conf`,
        `/usr/local/directadmin/data/users/${systemUser}/openlitespeed.conf`,
      ];
    case 'CPANEL':
      return [
        `/var/cpanel/userdata/${systemUser}/${domain}`,
        `/var/cpanel/userdata/${systemUser}/${domain}_SSL`,
      ];
    case 'PLESK':
      return [
        `/var/www/vhosts/system/${domain}/conf/httpd.conf`,
        `/var/www/vhosts/system/${domain}/conf/nginx.conf`,
      ];
    case 'AAPANEL':
      return [
        `/www/server/panel/vhost/nginx/${domain}.conf`,
        `/www/server/panel/vhost/apache/${domain}.conf`,
        `/www/server/panel/vhost/openlitespeed/${domain}.conf`,
      ];
    case 'CYBERPANEL':
      return [`/usr/local/lsws/conf/vhosts/${domain}/vhost.conf`];
    case 'HESTIACP':
      return [
        `/home/${systemUser}/conf/web/${domain}/nginx.conf`,
        `/home/${systemUser}/conf/web/${domain}/nginx.ssl.conf`,
        `/home/${systemUser}/conf/web/${domain}/apache2.conf`,
        `/home/${systemUser}/conf/web/${domain}/apache2.ssl.conf`,
      ];
    case 'CLOUDPANEL':
      return [
        `/etc/nginx/sites-enabled/${domain}.conf`,
        `/etc/nginx/sites-available/${domain}.conf`,
      ];
  }
}

function writeOrHardlinkMockFile(
  destFile: string,
  prevFile: string | null,
  content: string,
  mode = 0o600
): { totalBytes: number; deltaBytes: number } {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (prevFile && fs.existsSync(prevFile)) {
    try {
      const prevContent = fs.readFileSync(prevFile, 'utf8');
      if (prevContent === content) {
        if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
        fs.linkSync(prevFile, destFile);
        const sz = fs.statSync(destFile).size;
        return { totalBytes: sz, deltaBytes: 0 };
      }
    } catch {
      // Fallback sang ghi file mới
    }
  }
  fs.writeFileSync(destFile, content, { encoding: 'utf8', mode });
  const sz = Buffer.byteLength(content, 'utf8');
  return { totalBytes: sz, deltaBytes: sz };
}

function runRsyncPullMailbox(params: {
  jobId: number;
  server: ServerRecord;
  remoteMailboxDir: string;
  systemUser?: string;
  destMailboxDir: string;
  linkDestMailboxDir: string | null;
}): Promise<{ totalBytes: number; deltaBytes: number }> {
  const {
    jobId,
    server,
    remoteMailboxDir,
    systemUser,
    destMailboxDir,
    linkDestMailboxDir,
  } = params;

  fs.mkdirSync(destMailboxDir, { recursive: true });

  const args: string[] = [
    '-az',
    '--no-owner',
    '--no-group',
    '--chmod=ugo-s',
    '--no-keep-dirlinks',
    '--delete',
    '--no-devices',
    '--no-specials',
    '--safe-links',
    '--stats',
    '--partial',
    '--partial-dir=.rsync-partial',
    '--timeout=60',
  ];

  if (server.bw_limit_kbps && server.bw_limit_kbps > 0) {
    args.push(`--bwlimit=${server.bw_limit_kbps}`);
  }

  if (linkDestMailboxDir && fs.existsSync(linkDestMailboxDir)) {
    args.push(`--link-dest=${linkDestMailboxDir.replace(/\/+$/, '')}/`);
  }

  args.push('-e', buildRsyncSshTransport(server));
  // S3 Security Fix: Ghim inode thư mục Mailbox từ xa trong cùng phiên thực thi rsync
  args.push(
    `--rsync-path=${buildJailedRsyncPath(remoteMailboxDir, {
      runAsUser: systemUser,
      mode: 'pull',
    })}`
  );
  args.push(
    `${server.ssh_user || 'root'}@${server.ip_address}:./`,
    `${destMailboxDir.replace(/\/+$/, '')}/`
  );

  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: DETACHED_PROCESS_GROUP,
    });
    registerJobChildProcess(jobId, child);

    let fullStdout = '';
    let fullStderr = '';
    let lastActivityAt = Date.now();
    let idleTimedOut = false;

    const watcher = setInterval(() => {
      if (isJobCancelled(jobId)) {
        terminateChildGracefully(child);
        return;
      }
      if (Date.now() - lastActivityAt > STREAM_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        terminateChildGracefully(child);
      }
    }, 3000);

    child.stdout.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      fullStdout += chunk.toString('utf8');
      if (fullStdout.length > 65536) {
        fullStdout = fullStdout.slice(-32768);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      lastActivityAt = Date.now();
      fullStderr += chunk.toString('utf8');
      if (fullStderr.length > 65536) {
        fullStderr = fullStderr.slice(-32768);
      }
    });

    child.on('error', (err) => {
      clearInterval(watcher);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(watcher);
      const exitCode = code ?? 1;

      if (isJobCancelled(jobId)) {
        reject(new Error('Job đã bị hủy bởi quản trị viên.'));
        return;
      }

      if (idleTimedOut) {
        reject(
          new RetryableNetworkError(
            'Rsync Mailbox không phản hồi dữ liệu quá 30 phút (Idle Timeout).',
            30
          )
        );
        return;
      }

      if (exitCode !== 0 && exitCode !== 24) {
        if ([10, 12, 30, 35, 255].includes(exitCode)) {
          reject(
            new RetryableNetworkError(
              `Kết nối Rsync Mailbox gián đoạn (Mã lỗi ${exitCode}): ${fullStderr.trim()}`,
              exitCode
            )
          );
          return;
        }
        reject(
          new Error(
            `Rsync Mailbox thất bại (Mã lỗi ${exitCode}): ${fullStderr.trim()}`
          )
        );
        return;
      }

      const stats = parseRsyncStats(fullStdout);
      const measured =
        stats.totalBytes > 0
          ? stats.totalBytes
          : getDirectorySizeAndCount(destMailboxDir).totalBytes;
      resolve({ totalBytes: measured, deltaBytes: stats.deltaBytes });
    });
  });
}

/**
 * Giải nén luồng USTAR/POSIX tar.gz trong RAM giới hạn, CHỈ chấp nhận tập tin thông thường (< 256 KB),
 * loại bỏ hoàn toàn symlink/device/Tar-Slip và ghi ra thư mục vhosts với quyền 0600.
 */
function extractSafeVhostTarGzBuffer(
  tarGzBuf: Buffer,
  destVhostsDir: string
): { filesWritten: number; bytesWritten: number } {
  if (tarGzBuf.length === 0) {
    return { filesWritten: 0, bytesWritten: 0 };
  }

  const tarBuf = zlib.gunzipSync(tarGzBuf, {
    maxOutputLength: MAX_VHOST_ARCHIVE_UNCOMPRESSED_BYTES,
  });

  fs.mkdirSync(destVhostsDir, { recursive: true });
  const resolvedBase = path.resolve(destVhostsDir);

  let offset = 0;
  let filesWritten = 0;
  let bytesWritten = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    offset += 512;

    // Hai khối 512 bytes toàn 0 báo hiệu kết thúc gói tar
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = header
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    const prefix = header
      .subarray(345, 500)
      .toString('utf8')
      .replace(/\0.*$/, '');
    const fullTarPath = prefix ? `${prefix}/${rawName}` : rawName;

    const sizeOctal = header
      .subarray(124, 136)
      .toString('ascii')
      .replace(/\0.*$/, '')
      .trim();
    const fileSize = sizeOctal ? parseInt(sizeOctal, 8) || 0 : 0;
    const typeFlag = header[156];

    const dataStart = offset;
    const paddedSize = Math.ceil(fileSize / 512) * 512;
    offset += paddedSize;

    if (dataStart + fileSize > tarBuf.length) break;

    // Chỉ chấp nhận regular file ('0' = 0x30 hoặc '\0' = 0x00) và < 256 KB
    const isRegularFile = typeFlag === 0x30 || typeFlag === 0x00;
    if (!isRegularFile || fileSize <= 0 || fileSize > MAX_VHOST_FILE_BYTES) {
      continue;
    }

    const sanitizedName = fullTarPath
      .replace(/^[/\\]+/, '')
      .split(/[/\\]+/)
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join('__')
      .replace(/[^A-Za-z0-9._-]/g, '_');

    if (!sanitizedName || sanitizedName.startsWith('.')) {
      continue;
    }

    const outPath = path.resolve(resolvedBase, sanitizedName);
    if (!outPath.startsWith(resolvedBase + path.sep)) {
      continue;
    }

    const content = tarBuf.subarray(dataStart, dataStart + fileSize);
    fs.writeFileSync(outPath, content, { mode: 0o600 });
    filesWritten++;
    bytesWritten += content.length;
  }

  return { filesWritten, bytesWritten };
}

function pullRemoteVhostConfigsTarGz(
  jobId: number,
  server: ServerRecord,
  candidateFiles: string[]
): Promise<Buffer> {
  if (candidateFiles.length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }

  const quotedCandidates = candidateFiles.map((f) => shellSingleQuote(f)).join(' ');
  const remoteScript = `
    TMP_LIST=$(mktemp)
    trap 'rm -f "$TMP_LIST"' EXIT
    for f in ${quotedCandidates}; do
      if [ -f "$f" ] && [ ! -L "$f" ]; then
        sz=$(wc -c < "$f" 2>/dev/null || echo 999999)
        if [ "$sz" -gt 0 ] && [ "$sz" -le ${MAX_VHOST_FILE_BYTES} ]; then
          printf "%s\\n" "$f" >> "$TMP_LIST"
        fi
      fi
    done
    if [ -s "$TMP_LIST" ]; then
      tar -czf - -T "$TMP_LIST" 2>/dev/null || true
    fi
  `;

  const sshArgs = [
    ...buildSshBaseArgs(server),
    '--',
    `${server.ssh_user || 'root'}@${server.ip_address}`,
    remoteScript,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: DETACHED_PROCESS_GROUP,
    });
    registerJobChildProcess(jobId, child);

    const chunks: Buffer[] = [];
    let totalLen = 0;
    const timeoutTimer = setTimeout(() => {
      terminateChildGracefully(child);
    }, 60_000);
    timeoutTimer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      if (totalLen + chunk.length <= MAX_VHOST_ARCHIVE_UNCOMPRESSED_BYTES) {
        chunks.push(chunk);
        totalLen += chunk.length;
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeoutTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      if (isJobCancelled(jobId)) {
        reject(new Error('Job đã bị hủy bởi quản trị viên.'));
        return;
      }
      if (code === 255) {
        reject(
          new RetryableNetworkError(
            `Mất kết nối SSH khi sao lưu cấu hình Vhost trên ${server.hostname}`,
            255
          )
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * Pillar 3.1: Sao lưu Mở rộng Hosting (Mailboxes Maildir + User Cronjobs + Vhost & SSL Configs)
 */
export async function syncExtendedHostingExtras(params: {
  jobId: number;
  server: ServerRecord;
  domains: DiscoveredDomain[];
  inProgressDir: string;
  latestSnapshotDir: string | null;
  appendLog: (msg: string) => void;
}): Promise<{ deltaBytes: number; totalBytes: number }> {
  const {
    jobId,
    server,
    domains,
    inProgressDir,
    latestSnapshotDir,
    appendLog,
  } = params;

  const wantMailboxes = Number(server.backup_mailboxes || 0) === 1;
  const wantCronjobs = Number(server.backup_cronjobs || 0) === 1;
  const wantVhosts = Number(server.backup_vhost_configs || 0) === 1;

  if (!wantMailboxes && !wantCronjobs && !wantVhosts) {
    return { deltaBytes: 0, totalBytes: 0 };
  }

  let totalBytes = 0;
  let deltaBytes = 0;
  const extrasRoot = path.join(inProgressDir, 'system_extras');
  const prevExtrasRoot = latestSnapshotDir
    ? path.join(latestSnapshotDir, 'system_extras')
    : null;

  // Chế độ mô phỏng Demo (is_mock = 1)
  if (server.is_mock) {
    if (wantMailboxes) {
      for (const dom of domains) {
        if (!isSafeDomain(dom.domain)) continue;
        const rel = path.join(
          'mailboxes',
          dom.domain,
          'Maildir',
          'cur',
          'welcome.eml'
        );
        const emlContent = [
          `From: postmaster@${dom.domain}`,
          `To: admin@${dom.domain}`,
          `Subject: Welcome to ${dom.domain} Mail Server (${server.panel_type})`,
          `MIME-Version: 1.0`,
          `Content-Type: text/plain; charset=UTF-8`,
          ``,
          `Hộp thư doanh nghiệp cho tên miền ${dom.domain} đã được bảo vệ tự động bởi NAS-Sync Extended Backup.`,
          ``,
        ].join('\r\n');
        const res = writeOrHardlinkMockFile(
          path.join(extrasRoot, rel),
          prevExtrasRoot ? path.join(prevExtrasRoot, rel) : null,
          emlContent
        );
        totalBytes += res.totalBytes;
        deltaBytes += res.deltaBytes;
      }
      appendLog(
        `[Extended Extras] 📬 Đã đồng bộ hộp thư Maildir cho ${domains.length} domain vào system_extras/mailboxes/.`
      );
    }

    if (wantCronjobs) {
      const uniqueUsers = Array.from(
        new Set(domains.map((d) => d.systemUser).filter(isSafeSystemUser))
      );
      for (const sysUser of uniqueUsers) {
        const rel = path.join('cronjobs', `${sysUser}.crontab`);
        const cronContent = `# NAS-Sync Captured Crontab — User: ${sysUser} (${server.panel_type})\nSHELL=/bin/bash\n*/5 * * * * php /home/${sysUser}/cron.php >/dev/null 2>&1\n`;
        const res = writeOrHardlinkMockFile(
          path.join(extrasRoot, rel),
          prevExtrasRoot ? path.join(prevExtrasRoot, rel) : null,
          cronContent
        );
        totalBytes += res.totalBytes;
        deltaBytes += res.deltaBytes;
      }
      appendLog(
        `[Extended Extras] ⏱️ Đã lưu cấu hình Crontab của ${uniqueUsers.length} user hệ thống vào system_extras/cronjobs/.`
      );
    }

    if (wantVhosts) {
      for (const dom of domains) {
        if (!isSafeDomain(dom.domain)) continue;
        const rel = path.join('vhosts', `${dom.domain}.conf`);
        const vhostContent = `# Vhost & SSL Configuration (${server.panel_type})\n# Domain: ${dom.domain}\nserver {\n    listen 443 ssl http2;\n    server_name ${dom.domain} www.${dom.domain};\n    root ${dom.webroot};\n    index index.php index.html;\n}\n`;
        const res = writeOrHardlinkMockFile(
          path.join(extrasRoot, rel),
          prevExtrasRoot ? path.join(prevExtrasRoot, rel) : null,
          vhostContent
        );
        totalBytes += res.totalBytes;
        deltaBytes += res.deltaBytes;
      }
      appendLog(
        `[Extended Extras] 🛡️ Đã sao lưu ${domains.length} tệp cấu hình Vhost/SSL vào system_extras/vhosts/.`
      );
    }

    return { deltaBytes, totalBytes };
  }

  // Chế độ máy chủ Production qua SSH
  // 1. Mailboxes Incremental Rsync
  if (wantMailboxes) {
    let syncedMailDomains = 0;
    for (const dom of domains) {
      throwIfCancelled(jobId);
      assertSafe(isSafeDomain, dom.domain, 'domain');
      assertSafe(isSafeSystemUser, dom.systemUser, 'systemUser');

      const candidates = buildMailboxCandidates(
        server.panel_type,
        dom.systemUser,
        dom.domain
      );
      const quotedList = candidates.map((c) => shellSingleQuote(c)).join(' ');
      const probeScript = `
        SYS_USER=${shellSingleQuote(dom.systemUser)}
        DOM=${shellSingleQuote(dom.domain)}
        PANEL=${shellSingleQuote(server.panel_type)}
        USER_HOME=$(getent passwd "$SYS_USER" 2>/dev/null | cut -d: -f6 || true)
        REAL_HOME=""
        if [ -n "$USER_HOME" ] && [ "$USER_HOME" != "/" ]; then
          REAL_HOME=$(realpath -m -- "$USER_HOME" 2>/dev/null || readlink -m -- "$USER_HOME" 2>/dev/null || printf "%s" "$USER_HOME")
          REAL_HOME="\${REAL_HOME%/}"
        fi
        for CAND in ${quotedList}; do
          if [ -d "$CAND" ] && [ ! -L "$CAND" ]; then
            REAL=$(realpath -e -- "$CAND" 2>/dev/null || readlink -f -- "$CAND" 2>/dev/null || true)
            REAL="\${REAL%/}"
            case "$REAL/" in
              /|/etc/*|/root/*|/proc/*|/sys/*|/dev/*|/var/lib/mysql/*|/var/lib/postgresql/*)
                echo "JAIL|$REAL"
                exit 0
                ;;
            esac
            if [ "$PANEL" = "DIRECTADMIN" ] || [ "$PANEL" = "CPANEL" ] || [ "$PANEL" = "HESTIACP" ]; then
              if [ -n "$REAL_HOME" ] && [ "$REAL_HOME" != "/" ]; then
                case "$REAL/" in
                  "$REAL_HOME/"*)
                    printf "OK|%s\\n" "$REAL"
                    exit 0
                    ;;
                  *)
                    echo "JAIL|$REAL"
                    exit 0
                    ;;
                esac
              fi
            elif [ "$PANEL" = "PLESK" ]; then
              if [ "$REAL" = "/var/qmail/mailnames/$DOM" ]; then
                printf "OK|%s\\n" "$REAL"
                exit 0
              else
                echo "JAIL|$REAL"
                exit 0
              fi
            else
              if [ "$REAL" = "/home/vmail/$DOM" ] || [ "$REAL" = "/www/vmail/$DOM" ]; then
                printf "OK|%s\\n" "$REAL"
                exit 0
              else
                echo "JAIL|$REAL"
                exit 0
              fi
            fi
          fi
        done
        echo "NONE"
      `;

      const probeRes = await execRemoteSSH(server, probeScript, {
        zeroImpact: true,
        timeoutMs: 20000,
        jobId,
      });
      throwIfCancelled(jobId);
      if (probeRes.code === 255) {
        throw new RetryableNetworkError(
          `Mất kết nối SSH khi kiểm tra hộp thư của ${dom.domain}`,
          255
        );
      }

      const line = probeRes.stdout.trim().split('\n')[0]?.trim() || 'NONE';
      if (line.startsWith('JAIL|')) {
        appendLog(
          `[SECURITY] ⛔ Bỏ qua thư mục Mailbox có đường dẫn bất thường cho ${dom.domain}: ${line.slice(
            5
          )}`
        );
        continue;
      }
      if (!line.startsWith('OK|')) {
        continue;
      }

      const remoteMailboxDir = line.slice(3).trim();
      const destMailboxDir = path.join(extrasRoot, 'mailboxes', dom.domain);
      const linkDestMailboxDir = prevExtrasRoot
        ? path.join(prevExtrasRoot, 'mailboxes', dom.domain)
        : null;

      const mailStats = await runRsyncPullMailbox({
        jobId,
        server,
        remoteMailboxDir,
        systemUser: dom.systemUser,
        destMailboxDir,
        linkDestMailboxDir,
      });
      totalBytes += mailStats.totalBytes;
      deltaBytes += mailStats.deltaBytes;
      syncedMailDomains++;
    }
    appendLog(
      `[Extended Extras] 📬 Đã đồng bộ hộp thư Maildir cho ${syncedMailDomains}/${domains.length} domain.`
    );
  }

  // 2. User Cronjobs
  if (wantCronjobs) {
    const uniqueUsers = Array.from(
      new Set(domains.map((d) => d.systemUser).filter(Boolean))
    );
    const cronDir = path.join(extrasRoot, 'cronjobs');
    fs.mkdirSync(cronDir, { recursive: true });
    let savedCrons = 0;

    for (const sysUser of uniqueUsers) {
      throwIfCancelled(jobId);
      assertSafe(isSafeSystemUser, sysUser, 'systemUser');
      const cronRes = await execRemoteSSH(
        server,
        `crontab -u ${shellSingleQuote(sysUser)} -l 2>/dev/null || true`,
        { zeroImpact: true, timeoutMs: 15000, jobId }
      );
      throwIfCancelled(jobId);
      if (cronRes.code === 255) {
        throw new RetryableNetworkError(
          `Mất kết nối SSH khi trích xuất crontab của user ${sysUser}`,
          255
        );
      }
      const trimmed = cronRes.stdout.trim();
      if (trimmed && !/^no crontab for /i.test(trimmed)) {
        const content = `${trimmed}\n`;
        const outFile = path.join(cronDir, `${sysUser}.crontab`);
        fs.writeFileSync(outFile, content, { encoding: 'utf8', mode: 0o600 });
        const sz = Buffer.byteLength(content, 'utf8');
        totalBytes += sz;
        deltaBytes += sz;
        savedCrons++;
      }
    }
    appendLog(
      `[Extended Extras] ⏱️ Đã trích xuất ${savedCrons} tệp Crontab người dùng vào system_extras/cronjobs/.`
    );
  }

  // 3. Vhost & SSL Configs (< 256 KB per file, non-symlink, 0600 permissions)
  if (wantVhosts) {
    throwIfCancelled(jobId);
    const candidateSet = new Set<string>();
    for (const dom of domains) {
      assertSafe(isSafeDomain, dom.domain, 'domain');
      assertSafe(isSafeSystemUser, dom.systemUser, 'systemUser');
      for (const f of buildVhostCandidateFiles(
        server.panel_type,
        dom.systemUser,
        dom.domain
      )) {
        candidateSet.add(f);
      }
    }

    const vhostDir = path.join(extrasRoot, 'vhosts');
    fs.mkdirSync(vhostDir, { recursive: true });

    const tarGzBuf = await pullRemoteVhostConfigsTarGz(
      jobId,
      server,
      Array.from(candidateSet)
    );
    const extracted = extractSafeVhostTarGzBuffer(tarGzBuf, vhostDir);
    totalBytes += extracted.bytesWritten;
    deltaBytes += extracted.bytesWritten;

    appendLog(
      `[Extended Extras] 🛡️ Đã sao lưu an toàn ${extracted.filesWritten} tệp cấu hình Vhost/SSL vào system_extras/vhosts/.`
    );
  }

  return { deltaBytes, totalBytes };
}

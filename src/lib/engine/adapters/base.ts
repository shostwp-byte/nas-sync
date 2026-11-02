import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  PanelType,
  ServerRecord,
} from '@/types';
import {
  assertSafe,
  isSafeDbName,
  isSafeDomain,
  isSafeSystemUser,
  isSafeWebroot,
} from '../safe-names';

export interface PanelAdapter {
  readonly panelType: PanelType;

  discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]>;

  getMysqlAdminCredentials(server: ServerRecord): Promise<MysqlAdminCredentials>;

  resolveTargetWebroot(
    server: ServerRecord,
    systemUser: string,
    domain: string
  ): Promise<string>;

  buildPermissionFixCommand(
    systemUser: string,
    domain: string,
    targetWebroot: string
  ): string;
}

export type WebrootSafetyCheckResult =
  | { ok: true; resolvedPath: string }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'JAIL_VIOLATION' | 'SSH_ERROR';
      reason: string;
    };

/**
 * Chỉ truyền user hoặc --defaults-extra-file qua tham số dòng lệnh;
 * TUYỆT ĐỐI không đặt -p'...' lên argv để chống lộ mật khẩu qua `ps aux` trên VPS.
 */
export function buildMysqlAuthFlags(creds: MysqlAdminCredentials): string {
  if (creds.defaultsFile) {
    return `--defaults-extra-file=${shellSingleQuote(creds.defaultsFile)}`;
  }
  return `-u ${shellSingleQuote(creds.user)}`;
}

/**
 * Sinh đoạn mã tiền tố Bash chạy trực tiếp trên VPS để nạp MYSQL_PWD vào biến môi trường
 * từ file cấu hình nội bộ của Panel mà không xuất hiện trên danh sách tiến trình `ps aux`.
 */
export function buildRemoteMysqlEnvPrelude(creds: MysqlAdminCredentials): string {
  if (creds.defaultsFile) {
    return '';
  }
  if (creds.remoteAuthPrelude) {
    return `${creds.remoteAuthPrelude}\n`;
  }
  return '';
}

/**
 * Kiểm tra Symlink Webroot Jail trực tiếp trên VPS trước khi chạy rsync pull/push hoặc chown:
 * - Phân giải đường dẫn thực tế qua `realpath` / `readlink`
 * - Trên cPanel/DirectAdmin/HestiaCP/CloudPanel: bắt buộc nằm bên trong thư mục home thực của `systemUser` trong `/etc/passwd`
 * - Trên CyberPanel: bắt buộc nằm bên trong `/home/<domain_or_user>/...` (không bao giờ là `/home` gốc)
 * - Trên Plesk: bắt buộc nằm trong vhost root của `systemUser` hoặc `/var/www/vhosts/<domain>/...`
 * - Trên aaPanel: bắt buộc nằm trong `/www/wwwroot/<site>`
 * - Chặn tuyệt đối mọi symlink trỏ sang `/root`, `/etc`, `/proc`, `/var/lib/mysql`, `/var/lib/postgresql` hoặc tài khoản user khác.
 */
export async function verifyRemoteWebrootSafety(
  server: ServerRecord,
  panelType: PanelType,
  systemUser: string,
  webroot: string,
  options: { mustExist: boolean }
): Promise<WebrootSafetyCheckResult> {
  const cleanWebroot = normalizePosixWebroot(webroot);
  assertSafe(isSafeSystemUser, systemUser, 'systemUser');
  assertSafe((v) => isSafeWebroot(v, 2), cleanWebroot, 'webroot');

  if (server.is_mock) {
    return { ok: true, resolvedPath: cleanWebroot };
  }

  const checkScript = `
    TARGET=${shellSingleQuote(cleanWebroot)}
    SYS_USER=${shellSingleQuote(systemUser)}
    PANEL=${shellSingleQuote(panelType)}
    MUST_EXIST=${options.mustExist ? "'1'" : "'0'"}

    if [ "$MUST_EXIST" = "1" ]; then
      if [ ! -e "$TARGET" ]; then
        echo "ERR_NOT_FOUND"
        exit 0
      fi
      REAL=$(realpath -e "$TARGET" 2>/dev/null || readlink -f "$TARGET" 2>/dev/null || true)
    else
      if [ -L "$TARGET" ]; then
        LINK_REAL=$(realpath -m "$TARGET" 2>/dev/null || readlink -m "$TARGET" 2>/dev/null || true)
        REAL="$LINK_REAL"
      else
        REAL=$(realpath -m "$TARGET" 2>/dev/null || readlink -m "$TARGET" 2>/dev/null || true)
      fi
    fi

    if [ -z "$REAL" ]; then
      echo "ERR_JAIL|Không thể phân giải đường dẫn thực tế (realpath) cho $TARGET"
      exit 0
    fi

    if [ "$REAL" != "/" ]; then
      REAL="\${REAL%/}"
    fi

    case "$REAL/" in
      /|/etc/*|/root/*|/proc/*|/sys/*|/dev/*|/boot/*|/usr/*|/bin/*|/sbin/*|/lib/*|/lib64/*|/run/*|/var/lib/mysql/*|/var/lib/postgresql/*|/var/cpanel/*|/usr/local/directadmin/*|/usr/local/CyberCP/*|/usr/local/hestia/*|/home/clp/*|/www/server/panel/*)
        echo "ERR_JAIL|Đường dẫn webroot trỏ tới vùng hệ thống bị cấm ($REAL)"
        exit 0
        ;;
    esac

    if [ "$PANEL" = "AAPANEL" ]; then
      case "$REAL" in
        /www/wwwroot/*)
          if [ "$REAL" = "/www/wwwroot" ]; then
            echo "ERR_JAIL|Webroot không được là thư mục gốc /www/wwwroot"
            exit 0
          fi
          ;;
        *)
          echo "ERR_JAIL|Webroot aaPanel ($REAL) nằm ngoài phạm vi /www/wwwroot/"
          exit 0
          ;;
      esac
    elif [ "$PANEL" = "CYBERPANEL" ]; then
      case "$REAL" in
        /home/*/*)
          ;;
        /home|/home/*)
          echo "ERR_JAIL|Webroot CyberPanel ($REAL) phải nằm bên trong /home/<domain_or_user>/... (không được là /home hoặc thư mục cấp 1)"
          exit 0
          ;;
        *)
          echo "ERR_JAIL|Webroot CyberPanel ($REAL) nằm ngoài phạm vi /home/<domain_or_user>/..."
          exit 0
          ;;
      esac
    elif [ "$PANEL" = "PLESK" ]; then
      USER_HOME=$(getent passwd "$SYS_USER" 2>/dev/null | cut -d: -f6 || true)
      REAL_HOME=""
      if [ -n "$USER_HOME" ] && [ "$USER_HOME" != "/" ]; then
        REAL_HOME=$(realpath -m "$USER_HOME" 2>/dev/null || readlink -m "$USER_HOME" 2>/dev/null || printf "%s" "$USER_HOME")
        REAL_HOME="\${REAL_HOME%/}"
      fi
      if [ -n "$REAL_HOME" ] && [ "$REAL_HOME" != "/" ] && [ "$SYS_USER" != "root" ]; then
        case "$REAL/" in
          "$REAL_HOME/"*) ;;
          *)
            echo "ERR_JAIL|Webroot Plesk ($REAL) thoát khỏi phạm vi vhost của user $SYS_USER ($REAL_HOME)"
            exit 0
            ;;
        esac
      else
        case "$REAL" in
          /var/www/vhosts/*/*) ;;
          *)
            echo "ERR_JAIL|Webroot Plesk ($REAL) phải nằm trong /var/www/vhosts/<domain>/..."
            exit 0
            ;;
        esac
      fi
    else
      USER_HOME=$(getent passwd "$SYS_USER" 2>/dev/null | cut -d: -f6 || true)
      if [ -z "$USER_HOME" ] || [ "$USER_HOME" = "/" ]; then
        echo "ERR_JAIL|Không tìm thấy thư mục home hợp lệ trong /etc/passwd cho user $SYS_USER"
        exit 0
      fi
      REAL_HOME=$(realpath -m "$USER_HOME" 2>/dev/null || readlink -m "$USER_HOME" 2>/dev/null || printf "%s" "$USER_HOME")
      REAL_HOME="\${REAL_HOME%/}"
      if [ -z "$REAL_HOME" ] || [ "$REAL_HOME" = "/" ]; then
        echo "ERR_JAIL|Thư mục home thực tế của user $SYS_USER không hợp lệ ($REAL_HOME)"
        exit 0
      fi
      case "$REAL/" in
        "$REAL_HOME/"*)
          if [ "$REAL" = "$REAL_HOME" ]; then
            echo "ERR_JAIL|Webroot không được trùng chính xác thư mục gốc home ($REAL_HOME)"
            exit 0
          fi
          ;;
        *)
          echo "ERR_JAIL|Phát hiện Webroot/Symlink ($REAL) thoát khỏi phạm vi home của user $SYS_USER ($REAL_HOME)"
          exit 0
          ;;
      esac
    fi

    printf "OK|%s\\n" "$REAL"
  `;

  const res = await execRemoteSSH(server, checkScript, {
    zeroImpact: true,
    timeoutMs: 20000,
  });

  if (res.code === 255) {
    return {
      ok: false,
      code: 'SSH_ERROR',
      reason: res.stderr.trim() || 'Mất kết nối SSH tới VPS khi kiểm tra Webroot Jail.',
    };
  }

  const out = res.stdout.trim().split('\n')[0]?.trim() || '';
  if (out === 'ERR_NOT_FOUND') {
    return {
      ok: false,
      code: 'NOT_FOUND',
      reason: `Thư mục webroot ${cleanWebroot} chưa tồn tại trên VPS.`,
    };
  }
  if (out.startsWith('ERR_JAIL|')) {
    return {
      ok: false,
      code: 'JAIL_VIOLATION',
      reason: out.slice('ERR_JAIL|'.length).trim(),
    };
  }
  if (res.code === 0 && out.startsWith('OK|')) {
    return {
      ok: true,
      resolvedPath: out.slice(3).trim() || cleanWebroot,
    };
  }

  return {
    ok: false,
    code: 'SSH_ERROR',
    reason:
      res.stderr.trim() ||
      out ||
      `Không thể xác minh tính an toàn của webroot ${cleanWebroot} (exit ${res.code}).`,
  };
}

/**
 * Loại bỏ domain / DB có tên nguy hiểm do VPS trả về (khách hàng hosting kiểm soát được tên DB,
 * VPS bị chiếm quyền có thể trả về domain "../../..."). Các tên này về sau được ghép vào lệnh
 * shell root trên VPS, bash trên NAS và đường dẫn rsync --delete trên NAS.
 * Bỏ qua thay vì throw để một khách hàng độc hại không làm hỏng backup của cả máy chủ.
 */
function filterUnsafeDiscoveredDomains(rawDomains: DiscoveredDomain[]): DiscoveredDomain[] {
  const out: DiscoveredDomain[] = [];
  for (const item of rawDomains) {
    const domain = item.domain.trim();
    const webroot = normalizePosixWebroot(item.webroot);
    if (!domain) continue;
    if (
      !isSafeDomain(domain) ||
      !isSafeSystemUser(item.systemUser) ||
      !isSafeWebroot(webroot, 2)
    ) {
      console.warn(
        `[NAS-Sync Security] Bỏ qua domain có định danh không an toàn: ${JSON.stringify({
          domain: item.domain,
          systemUser: item.systemUser,
          webroot: item.webroot,
        })}`
      );
      continue;
    }
    const databases = item.databases.filter((db) => {
      if (isSafeDbName(db.name)) return true;
      console.warn(
        `[NAS-Sync Security] Bỏ qua database có tên không an toàn trên ${domain}: ${JSON.stringify(db.name)}`
      );
      return false;
    });
    out.push({ ...item, databases });
  }
  return out;
}

function normalizePosixWebroot(p: string): string {
  const trimmed = p.trim().replace(/\/+$/, '');
  return trimmed || '/';
}

/**
 * Chuẩn hóa danh sách Domain & Subdomain sau khi quét:
 * 1. Ưu tiên giữ Domain chính/Addon trước Subdomain nếu trùng chính xác cùng một webroot vật lý (VD: companion subdomain của Addon Domain trên cPanel), gộp DB không mất dữ liệu.
 * 2. Tự động tính toán `excludedSubpaths` cho Domain cha nếu có Subdomain con nằm lồng bên trong webroot của Domain cha
 *    (VD: /public_html/shop nằm trong /public_html -> exclude "shop" ở domain cha để không tải trùng 2 lần và không xóa nhầm khi Restore domain cha).
 */
export function finalizeDiscoveredDomains(
  rawDomains: DiscoveredDomain[]
): DiscoveredDomain[] {
  const safeDomains = filterUnsafeDiscoveredDomains(rawDomains);

  // Sắp xếp Domain chính trước, Subdomain sau để khi trùng webroot vật lý thì ưu tiên tên miền chính/addon
  const sorted = [...safeDomains].sort((a, b) => {
    const aSub = a.isSubdomain ? 1 : 0;
    const bSub = b.isSubdomain ? 1 : 0;
    return aSub - bSub;
  });

  const byDomainName = new Map<string, DiscoveredDomain>();
  const byUserWebroot = new Map<string, DiscoveredDomain>();

  for (const item of sorted) {
    const domKey = item.domain.trim().toLowerCase();
    if (!domKey) continue;

    const cleanWebroot = normalizePosixWebroot(item.webroot);
    const webrootKey = `${item.systemUser}::${cleanWebroot}`;

    if (byDomainName.has(domKey)) {
      const existing = byDomainName.get(domKey)!;
      for (const db of item.databases) {
        if (!existing.databases.some((d) => d.name === db.name)) {
          existing.databases.push(db);
        }
      }
      continue;
    }

    if (byUserWebroot.has(webrootKey)) {
      // Trùng hoàn toàn đường dẫn webroot vật lý trên cùng systemUser (VD: cPanel addon companion subdomain)
      const primary = byUserWebroot.get(webrootKey)!;
      for (const db of item.databases) {
        if (!primary.databases.some((d) => d.name === db.name)) {
          primary.databases.push(db);
        }
      }
      continue;
    }

    const normalizedItem: DiscoveredDomain = {
      ...item,
      domain: item.domain.trim(),
      webroot: cleanWebroot,
      databases: [...item.databases],
    };

    byDomainName.set(domKey, normalizedItem);
    byUserWebroot.set(webrootKey, normalizedItem);
  }

  const result = Array.from(byDomainName.values());

  // Tính toán excludedSubpaths cho các webroot cha chứa webroot của subdomain con bên trong
  for (const parent of result) {
    const parentRoot = normalizePosixWebroot(parent.webroot);
    if (parentRoot === '/') continue;
    const prefix = `${parentRoot}/`;
    const exclusions = new Set<string>(parent.excludedSubpaths || []);

    for (const child of result) {
      if (child.domain === parent.domain) continue;
      const childRoot = normalizePosixWebroot(child.webroot);
      if (childRoot.startsWith(prefix)) {
        const relSubpath = childRoot.slice(prefix.length).replace(/^\/+|\/+$/g, '');
        if (relSubpath) {
          exclusions.add(relSubpath);
        }
      }
    }

    if (exclusions.size > 0) {
      parent.excludedSubpaths = Array.from(exclusions);
    }
  }

  return result;
}


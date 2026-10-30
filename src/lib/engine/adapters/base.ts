import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  PanelType,
  ServerRecord,
} from '@/types';

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

export function buildMysqlAuthFlags(creds: MysqlAdminCredentials): string {
  if (creds.defaultsFile) {
    return `--defaults-extra-file="${creds.defaultsFile}"`;
  }
  const escapedPass = (creds.password || '').replace(/'/g, `'\\''`);
  if (creds.password) {
    return `-u"${creds.user}" -p'${escapedPass}'`;
  }
  return `-u"${creds.user}"`;
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
  // Sắp xếp Domain chính trước, Subdomain sau để khi trùng webroot vật lý thì ưu tiên tên miền chính/addon
  const sorted = [...rawDomains].sort((a, b) => {
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


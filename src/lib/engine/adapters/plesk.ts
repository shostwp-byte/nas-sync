import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class PleskAdapter implements PanelAdapter {
  readonly panelType = 'PLESK' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const res = await execRemoteSSH(
      server,
      'if [ -f /etc/psa/.psa.shadow ]; then cat /etc/psa/.psa.shadow; else exit 1; fi',
      { zeroImpact: true }
    );
    if (res.code !== 0) {
      throw new Error(
        `Không thể đọc /etc/psa/.psa.shadow trên Plesk ${server.hostname}: ${res.stderr}`
      );
    }
    return {
      user: 'admin',
      password: res.stdout.trim(),
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const script = `
      PSA_PASS=$(cat /etc/psa/.psa.shadow)
      MYSQL_PWD="$PSA_PASS" mysql -u admin -D psa -N -B -e "
        SELECT
          d.name,
          COALESCE(s.login, ps.login, 'root') AS sys_login,
          h.www_root,
          IFNULL(h.php_handler_id, 'plesk-php82'),
          CASE WHEN IFNULL(d.parentDomainId, 0) > 0 OR d.htype = 'subdomain' THEN 1 ELSE 0 END AS is_sub,
          IFNULL(parent.name, '') AS parent_name,
          IFNULL((
            SELECT GROUP_CONCAT(db.name SEPARATOR ',')
            FROM data_bases db
            WHERE db.dom_id = d.id AND db.type = 'mysql'
          ), '')
        FROM domains d
        JOIN hosting h ON d.id = h.dom_id
        LEFT JOIN sys_users s ON h.sys_user_id = s.id
        LEFT JOIN domains parent ON d.parentDomainId = parent.id AND d.parentDomainId > 0
        LEFT JOIN hosting ph ON parent.id = ph.dom_id
        LEFT JOIN sys_users ps ON ph.sys_user_id = ps.id
        WHERE d.htype IN ('vrt_hst', 'subdomain')
        ORDER BY is_sub ASC, d.id ASC;
      "
    `;

    const res = await execRemoteSSH(server, script, {
      zeroImpact: true,
      timeoutMs: 90000,
    });
    if (res.code !== 0) {
      throw new Error(
        `Lỗi truy vấn DB psa trên Plesk ${server.hostname}: ${res.stderr}`
      );
    }

    const out: DiscoveredDomain[] = [];
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [
        domain,
        systemUser,
        webroot,
        phpVersion,
        isSubFlag,
        parentDom,
        dbsCsv,
      ] = trimmed.split('\t');
      if (!domain || !systemUser) continue;
      const databases = (dbsCsv || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name, user: systemUser }));
      out.push({
        domain,
        systemUser,
        webroot: webroot || `/var/www/vhosts/${domain}/httpdocs`,
        phpVersion: phpVersion || 'plesk-php82',
        isSubdomain: isSubFlag === '1',
        parentDomain: parentDom?.trim() || undefined,
        databases,
      });
    }
    return finalizeDiscoveredDomains(out);
  }

  async resolveTargetWebroot(
    server: ServerRecord,
    _systemUser: string,
    domain: string
  ): Promise<string> {
    if (!server.is_mock) {
      const safeDom = domain.replace(/[^a-zA-Z0-9._-]/g, '');
      const checkCmd = `
        if [ -f /etc/psa/.psa.shadow ]; then
          PSA_PASS=$(cat /etc/psa/.psa.shadow)
          WROOT=$(MYSQL_PWD="$PSA_PASS" mysql -u admin -D psa -N -B -e "SELECT h.www_root FROM domains d JOIN hosting h ON d.id = h.dom_id WHERE d.name = '${safeDom}' LIMIT 1;" 2>/dev/null || true)
          [ -n "$WROOT" ] && echo "$WROOT" && exit 0
        fi
        echo "/var/www/vhosts/${safeDom}/httpdocs"
      `;
      const res = await execRemoteSSH(server, checkCmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/var/www/vhosts/${domain}/httpdocs`;
  }

  buildPermissionFixCommand(
    systemUser: string,
    domain: string,
    targetWebroot: string
  ): string {
    return `plesk repair fs ${shellSingleQuote(
      domain
    )} -y || chown -R ${shellSingleQuote(`${systemUser}:psacln`)} ${shellSingleQuote(
      targetWebroot
    )}`;
  }
}

import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import {
  assertSafe,
  isSafeDomain,
  isSafeSystemUser,
} from '../safe-names';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class CyberPanelAdapter implements PanelAdapter {
  readonly panelType = 'CYBERPANEL' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const script = `
      if [ -f /etc/cyberpanel/mysqlPassword ]; then
        P=$(tr -d '\\r\\n' < /etc/cyberpanel/mysqlPassword)
        printf "CYBER|%s\\n" "$P"
      elif [ -f /root/.my.cnf ]; then
        U=$(grep -E '^user[[:space:]]*=' /root/.my.cnf | head -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        P=$(grep -E '^password[[:space:]]*=' /root/.my.cnf | head -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        printf "MYCNF|%s|%s\\n" "\${U:-root}" "$P"
      else
        echo "ERR_NO_CRED"
        exit 1
      fi
    `;
    const res = await execRemoteSSH(server, script, { zeroImpact: true });
    if (res.code !== 0 || res.stdout.includes('ERR_NO_CRED')) {
      throw new Error(
        `Không đọc được thông tin xác thực MySQL (/etc/cyberpanel/mysqlPassword hoặc /root/.my.cnf) trên CyberPanel ${server.hostname}: ${res.stderr}`
      );
    }

    const line = res.stdout.split(/\r?\n/)[0] || '';
    if (line.startsWith('CYBER|')) {
      const password = line.slice('CYBER|'.length).trim();
      return {
        user: 'root',
        password,
        remoteAuthPrelude:
          'export MYSQL_PWD="$(tr -d \'\\r\\n\' < /etc/cyberpanel/mysqlPassword)"',
      };
    }

    const parts = line.split('|');
    return {
      user: (parts[1] || 'root').trim() || 'root',
      password: (parts[2] || '').trim() || undefined,
      defaultsFile: '/root/.my.cnf',
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const creds = await this.getMysqlAdminCredentials(server);
    const authPart = creds.defaultsFile
      ? `--defaults-extra-file=${shellSingleQuote(creds.defaultsFile)}`
      : `-u ${shellSingleQuote(creds.user)}`;
    const prelude = creds.remoteAuthPrelude ? `${creds.remoteAuthPrelude}\n` : '';

    const script = `
      ${prelude}
      mysql ${authPart} -D cyberpanel -N -B -e "
        SELECT
          'MAIN',
          w.id,
          w.domain,
          IFNULL(NULLIF(w.externalApp, ''), 'nobody'),
          CONCAT('/home/', w.domain, '/public_html'),
          IFNULL(NULLIF(w.phpSelection, ''), 'PHP 8.2'),
          '',
          IFNULL((
            SELECT GROUP_CONCAT(CONCAT(d.dbName, ':', IFNULL(d.dbUser, '')) SEPARATOR ',')
            FROM databases_databases d
            WHERE d.website_id = w.id
          ), '')
        FROM websiteFunctions_websites w
        ORDER BY w.id ASC;
      " 2>/dev/null || true

      mysql ${authPart} -D cyberpanel -N -B -e "
        SELECT
          'CHILD',
          c.id,
          c.domain,
          IFNULL(NULLIF(w.externalApp, ''), 'nobody'),
          IFNULL(NULLIF(c.path, ''), CONCAT('/home/', w.domain, '/', c.domain)),
          IFNULL(NULLIF(c.phpSelection, ''), IFNULL(w.phpSelection, 'PHP 8.2')),
          w.domain,
          ''
        FROM websiteFunctions_childdomains c
        JOIN websiteFunctions_websites w ON c.master_id = w.id
        ORDER BY c.id ASC;
      " 2>/dev/null || true
      unset MYSQL_PWD
    `;

    const res = await execRemoteSSH(server, script, {
      zeroImpact: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) {
      throw new Error(
        `Lỗi truy vấn CSDL CyberPanel trên ${server.hostname}: ${res.stderr}`
      );
    }

    const rawOut: DiscoveredDomain[] = [];
    for (const rawLine of res.stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const [kind, , domain, sysUser, webroot, phpVer, parentDom, dbsCsv] =
        line.split('\t');
      if ((kind !== 'MAIN' && kind !== 'CHILD') || !domain) continue;

      const databases = (dbsCsv || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((pair) => {
          const idx = pair.indexOf(':');
          const name = idx >= 0 ? pair.slice(0, idx).trim() : pair;
          const dbUser = idx >= 0 ? pair.slice(idx + 1).trim() : '';
          return {
            name,
            user: dbUser || sysUser || 'root',
            engine: 'MYSQL' as const,
          };
        })
        .filter((d) => Boolean(d.name));

      rawOut.push({
        domain: domain.trim(),
        systemUser: (sysUser || 'nobody').trim(),
        webroot: (webroot || `/home/${domain.trim()}/public_html`).trim(),
        phpVersion: (phpVer || 'PHP 8.2').trim(),
        isSubdomain: kind === 'CHILD',
        parentDomain: kind === 'CHILD' && parentDom ? parentDom.trim() : undefined,
        databases,
      });
    }

    return finalizeDiscoveredDomains(rawOut);
  }

  async resolveTargetWebroot(
    server: ServerRecord,
    _systemUser: string,
    domain: string
  ): Promise<string> {
    assertSafe(isSafeDomain, domain, 'domain');

    if (!server.is_mock) {
      const safeDom = domain.replace(/[^a-zA-Z0-9._-]/g, '');
      const checkCmd = `
        if [ -f /etc/cyberpanel/mysqlPassword ]; then
          export MYSQL_PWD="$(tr -d '\\r\\n' < /etc/cyberpanel/mysqlPassword)"
          CPATH=$(mysql -u root -D cyberpanel -N -B -e "SELECT path FROM websiteFunctions_childdomains WHERE domain = '${safeDom}' LIMIT 1;" 2>/dev/null || true)
          unset MYSQL_PWD
          [ -n "$CPATH" ] && echo "$CPATH" && exit 0
        fi
        echo "/home/${safeDom}/public_html"
      `;
      const res = await execRemoteSSH(server, checkCmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/home/${domain}/public_html`;
  }

  buildPermissionFixCommand(
    systemUser: string,
    _domain: string,
    targetWebroot: string
  ): string {
    assertSafe(isSafeSystemUser, systemUser, 'systemUser');
    return `chown -hR ${shellSingleQuote(`${systemUser}:${systemUser}`)} ${shellSingleQuote(
      targetWebroot
    )}`;
  }
}

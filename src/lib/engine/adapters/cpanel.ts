import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class CPanelAdapter implements PanelAdapter {
  readonly panelType = 'CPANEL' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const script = `
      if [ -f /root/.my.cnf ]; then
        U=$(grep -E '^user\\s*=' /root/.my.cnf | head -n1 | cut -d= -f2- | tr -d ' "'\''')
        P=$(grep -E '^password\\s*=' /root/.my.cnf | head -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        printf "OK|%s|%s\\n" "\${U:-root}" "$P"
      else
        echo "ERR_NO_MYCNF"
        exit 1
      fi
    `;
    const res = await execRemoteSSH(server, script, { zeroImpact: true });
    if (res.code !== 0 || !res.stdout.startsWith('OK|')) {
      throw new Error(
        `Không đọc được /root/.my.cnf trên máy chủ cPanel ${server.hostname}: ${res.stderr}`
      );
    }
    const [, user, password] = res.stdout.trim().split('|');
    return {
      user: user || 'root',
      password: password || undefined,
      defaultsFile: '/root/.my.cnf',
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const script = `
      ALL_DBS=$(mysql --defaults-extra-file=/root/.my.cnf -N -B -e "SHOW DATABASES;" 2>/dev/null | grep -Ev '^(information_schema|performance_schema|mysql|sys|cphulkd|eximstats|leechprotect|modsec|roundcube)$' || true)

      detect_dbs_in_webroot() {
        wroot="$1"
        udbs="$2"
        [ -z "$udbs" ] && return 0
        [ ! -d "$wroot" ] && return 0
        cfg_blob=""
        for cf in "$wroot/wp-config.php" "$wroot/.env" "$wroot/configuration.php" "$wroot/config.php"; do
          if [ -f "$cf" ] && [ ! -L "$cf" ]; then
            cfg_blob="$cfg_blob
$(head -n 120 "$cf" 2>/dev/null || true)"
          fi
        done
        [ -z "$cfg_blob" ] && return 0
        matched=""
        OLD_IFS="$IFS"
        IFS=","
        for dbn in $udbs; do
          [ -z "$dbn" ] && continue
          if printf "%s" "$cfg_blob" | grep -Fq "$dbn"; then
            if [ -z "$matched" ]; then matched="$dbn"; else matched="$matched,$dbn"; fi
          fi
        done
        IFS="$OLD_IFS"
        printf "%s" "$matched"
      }

      SEEN_USERS=","
      if [ -f /etc/userdatadomains ]; then
        while IFS= read -r line || [ -n "$line" ]; do
          [ -z "$line" ] && continue
          dom=$(printf "%s" "$line" | cut -d: -f1 | tr -d ' \\r\\n')
          [ -z "$dom" ] && continue
          rest=$(printf "%s" "$line" | cut -d: -f2-)
          sys_user=$(printf "%s" "$rest" | cut -d= -f1 | tr -d ' ')
          dtype=$(printf "%s" "$rest" | cut -d= -f5 | tr -d ' ')
          parent_dom=$(printf "%s" "$rest" | cut -d= -f7 | tr -d ' ')
          fallback_doc=$(printf "%s" "$rest" | cut -d= -f9 | tr -d '\\r\\n')
          [ "$dtype" = "parked" ] && continue

          user_dbs=$(printf "%s\\n" "$ALL_DBS" | grep -E "^$\{sys_user}_" | paste -sd "," - || true)
          case "$SEEN_USERS" in
            *,"$sys_user",*) ;;
            *)
              printf "USERDBS|%s|%s\\n" "$sys_user" "$user_dbs"
              SEEN_USERS="$\{SEEN_USERS}$\{sys_user},"
              ;;
          esac

          udata="/var/cpanel/userdata/$sys_user/$dom"
          webroot="$\{fallback_doc:-/home/$sys_user/public_html}"
          php_ver="ea-php81"
          if [ -f "$udata" ]; then
            doc=$(grep -E '^documentroot:' "$udata" | head -n1 | awk '{print $2}')
            [ -n "$doc" ] && webroot="$doc"
            pv=$(grep -E '^phpversion:' "$udata" | head -n1 | awk '{print $2}')
            [ -n "$pv" ] && php_ver="$pv"
          fi

          is_sub="0"
          [ "$dtype" = "sub" ] && is_sub="1"
          site_dbs=$(detect_dbs_in_webroot "$webroot" "$user_dbs")
          printf "ROW|%s|%s|%s|%s|%s|%s|%s\\n" "$dom" "$sys_user" "$webroot" "$php_ver" "$is_sub" "$parent_dom" "$site_dbs"
        done < /etc/userdatadomains
      fi
    `;

    const res = await execRemoteSSH(server, script, {
      zeroImpact: true,
      timeoutMs: 90000,
    });
    if (res.code !== 0) {
      throw new Error(
        `Lỗi quét /etc/userdatadomains trên cPanel ${server.hostname}: ${res.stderr}`
      );
    }

    const userAllDbs = new Map<string, string[]>();
    const claimedUserDbs = new Map<string, Set<string>>();
    const rawOut: DiscoveredDomain[] = [];

    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('USERDBS|')) {
        const [, sysUser, dbsCsv] = line.split('|');
        if (sysUser) {
          userAllDbs.set(
            sysUser.trim(),
            (dbsCsv || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          );
          claimedUserDbs.set(sysUser.trim(), new Set());
        }
        continue;
      }

      if (!line.startsWith('ROW|')) continue;
      const [, domain, systemUser, webroot, phpVersion, isSubFlag, parentDom, dbsCsv] =
        line.split('|');
      if (!domain || !systemUser) continue;

      const cleanUser = systemUser.trim();
      const claimed = claimedUserDbs.get(cleanUser) || new Set<string>();
      claimedUserDbs.set(cleanUser, claimed);

      const siteDbs: Array<{ name: string; user?: string }> = [];
      for (const rawDb of (dbsCsv || '').split(',')) {
        const dbName = rawDb.trim();
        if (dbName && !claimed.has(dbName)) {
          claimed.add(dbName);
          siteDbs.push({ name: dbName, user: cleanUser });
        }
      }

      rawOut.push({
        domain: domain.trim(),
        systemUser: cleanUser,
        webroot: webroot.trim(),
        phpVersion: (phpVersion || 'ea-php81').trim(),
        isSubdomain: isSubFlag === '1',
        parentDomain:
          isSubFlag === '1' && parentDom?.trim() && parentDom.trim() !== domain.trim()
            ? parentDom.trim()
            : undefined,
        databases: siteDbs,
      });
    }

    for (const [sysUser, allDbs] of userAllDbs.entries()) {
      const claimed = claimedUserDbs.get(sysUser) || new Set<string>();
      const unclaimed = allDbs.filter((d) => !claimed.has(d));
      if (unclaimed.length > 0) {
        const primaryDom =
          rawOut.find((d) => d.systemUser === sysUser && !d.isSubdomain) ||
          rawOut.find((d) => d.systemUser === sysUser);
        if (primaryDom) {
          for (const dbName of unclaimed) {
            primaryDom.databases.push({ name: dbName, user: sysUser });
          }
        }
      }
    }

    return finalizeDiscoveredDomains(rawOut);
  }

  async resolveTargetWebroot(
    server: ServerRecord,
    systemUser: string,
    domain: string
  ): Promise<string> {
    if (!server.is_mock) {
      const cmd = `
        UDATA="/var/cpanel/userdata/${systemUser}/${domain}"
        if [ -f "$UDATA" ]; then
          DOC=$(grep -E '^documentroot:' "$UDATA" | head -n1 | awk '{print $2}')
          [ -n "$DOC" ] && echo "$DOC" && exit 0
        fi
        if [ -f /etc/userdatadomains ]; then
          LINE_DOC=$(grep -E "^${domain}:" /etc/userdatadomains 2>/dev/null | head -n1 | cut -d: -f2- | cut -d= -f9)
          [ -n "$LINE_DOC" ] && echo "$LINE_DOC" && exit 0
        fi
        echo "/home/${systemUser}/public_html"
      `;
      const res = await execRemoteSSH(server, cmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/home/${systemUser}/public_html`;
  }

  buildPermissionFixCommand(
    systemUser: string,
    _domain: string,
    targetWebroot: string
  ): string {
    return `chown -R ${shellSingleQuote(`${systemUser}:${systemUser}`)} ${shellSingleQuote(
      targetWebroot
    )} && chown ${shellSingleQuote(`${systemUser}:nobody`)} ${shellSingleQuote(
      targetWebroot
    )} 2>/dev/null || chown -R ${shellSingleQuote(
      `${systemUser}:${systemUser}`
    )} ${shellSingleQuote(targetWebroot)}`;
  }
}

import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DatabaseEngine,
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

export class HestiaCpAdapter implements PanelAdapter {
  readonly panelType = 'HESTIACP' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const script = `
      CONF="/usr/local/hestia/conf/mysql.conf"
      if [ -f "$CONF" ]; then
        LINE=$(grep -v '^[[:space:]]*#' "$CONF" | head -n1)
        U=$(printf "%s" "$LINE" | sed -n "s/.*USER='\\([^']*\\)'.*/\\1/p")
        P=$(printf "%s" "$LINE" | sed -n "s/.*PASSWORD='\\([^']*\\)'.*/\\1/p")
        printf "HESTIA|%s|%s\\n" "\${U:-root}" "$P"
      elif [ -f /root/.my.cnf ]; then
        printf "MYCNF|root|\\n"
      else
        echo "ERR_NO_CONF"
        exit 1
      fi
    `;
    const res = await execRemoteSSH(server, script, { zeroImpact: true });
    if (res.code !== 0 || res.stdout.includes('ERR_NO_CONF')) {
      throw new Error(
        `Không đọc được /usr/local/hestia/conf/mysql.conf trên HestiaCP ${server.hostname}: ${res.stderr}`
      );
    }

    const first = res.stdout.split(/\r?\n/)[0] || '';
    if (first.startsWith('MYCNF|')) {
      return {
        user: 'root',
        defaultsFile: '/root/.my.cnf',
      };
    }

    const [, rawUser, rawPass] = first.split('|');
    return {
      user: (rawUser || 'root').trim() || 'root',
      password: (rawPass || '').trim(),
      remoteAuthPrelude:
        'export MYSQL_PWD="$(grep -v \'^[[:space:]]*#\' /usr/local/hestia/conf/mysql.conf | head -n1 | sed -n "s/.*PASSWORD=\'\\([^\']*\\)\'.*/\\1/p" | tr -d \'\\r\\n\')"',
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const pyScript = `
import glob, json, os, shlex

def parse_hestia_conf(path):
    rows = []
    if not os.path.isfile(path):
        return rows
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                item = {}
                try:
                    tokens = shlex.split(line)
                except Exception:
                    tokens = line.split()
                for tok in tokens:
                    if '=' in tok:
                        k, v = tok.split('=', 1)
                        item[k.strip()] = v.strip().strip("'").strip('"')
                if item:
                    rows.append(item)
    except Exception:
        pass
    return rows

def detect_dbs(webroot, db_names):
    if not db_names or not os.path.isdir(webroot):
        return set()
    blob = ''
    for cf in ('wp-config.php', '.env', 'configuration.php', 'config.php', 'app/etc/env.php'):
        full = os.path.join(webroot, cf)
        if os.path.isfile(full) and not os.path.islink(full):
            try:
                with open(full, 'r', encoding='utf-8', errors='replace') as fh:
                    blob += '\\n' + fh.read(16384)
            except Exception:
                pass
    if not blob:
        return set()
    return {n for n in db_names if n in blob}

out = []
for udir in sorted(glob.glob('/usr/local/hestia/data/users/*')):
    if not os.path.isdir(udir):
        continue
    sys_user = os.path.basename(udir)
    if sys_user in ('', '.'):
        continue

    web_rows = [
        r for r in parse_hestia_conf(os.path.join(udir, 'web.conf'))
        if r.get('DOMAIN') and r.get('SUSPENDED', 'no') != 'yes'
    ]
    if not web_rows:
        continue

    db_rows = [
        r for r in parse_hestia_conf(os.path.join(udir, 'db.conf'))
        if r.get('DB') and r.get('SUSPENDED', 'no') != 'yes'
    ]

    user_dbs = []
    for dr in db_rows:
        dtype = (dr.get('TYPE') or 'mysql').lower()
        if dtype in ('pgsql', 'postgres', 'postgresql'):
            eng = 'POSTGRESQL'
        elif dtype in ('mysql', 'mariadb'):
            eng = 'MYSQL'
        else:
            continue
        user_dbs.append({
            'name': dr['DB'],
            'user': dr.get('DBUSER') or sys_user,
            'engine': eng
        })

    all_dom_names = [r['DOMAIN'].strip().lower() for r in web_rows]
    db_by_name = {d['name']: d for d in user_dbs}
    claimed = set()
    user_dom_entries = []

    for wr in web_rows:
        dom = wr['DOMAIN'].strip()
        custom_doc = (wr.get('CUSTOM_DOCROOT') or '').strip()
        webroot = custom_doc if custom_doc else f'/home/{sys_user}/web/{dom}/public_html'
        backend = (wr.get('BACKEND') or 'PHP-8_2').strip()

        parent_dom = None
        dom_lower = dom.lower()
        for cand in all_dom_names:
            if cand != dom_lower and dom_lower.endswith('.' + cand):
                if parent_dom is None or len(cand) > len(parent_dom):
                    parent_dom = cand

        matched_names = detect_dbs(webroot, list(db_by_name.keys()))
        site_dbs = []
        for dn in sorted(matched_names):
            if dn not in claimed:
                claimed.add(dn)
                site_dbs.append(db_by_name[dn])

        entry = {
            'domain': dom,
            'systemUser': sys_user,
            'webroot': webroot.rstrip('/'),
            'phpVersion': backend,
            'isSubdomain': bool(parent_dom),
            'parentDomain': parent_dom,
            'databases': site_dbs
        }
        user_dom_entries.append(entry)
        out.append(entry)

    unclaimed = [d for d in user_dbs if d['name'] not in claimed]
    if unclaimed and user_dom_entries:
        primary = next((e for e in user_dom_entries if not e['isSubdomain']), user_dom_entries[0])
        primary['databases'].extend(unclaimed)

print(json.dumps(out))
`;

    const res = await execRemoteSSH(
      server,
      `python3 -c ${shellSingleQuote(pyScript)}`,
      { zeroImpact: true, timeoutMs: 60000 }
    );
    if (res.code !== 0) {
      throw new Error(
        `Lỗi quét danh sách domain/database HestiaCP trên ${server.hostname}: ${res.stderr}`
      );
    }

    const parsed = JSON.parse(res.stdout.trim() || '[]') as Array<{
      domain: string;
      systemUser: string;
      webroot: string;
      phpVersion: string;
      isSubdomain?: boolean;
      parentDomain?: string;
      databases: Array<{ name: string; user?: string; engine?: DatabaseEngine }>;
    }>;
    return finalizeDiscoveredDomains(parsed);
  }

  async resolveTargetWebroot(
    server: ServerRecord,
    systemUser: string,
    domain: string
  ): Promise<string> {
    assertSafe(isSafeSystemUser, systemUser, 'systemUser');
    assertSafe(isSafeDomain, domain, 'domain');

    if (!server.is_mock) {
      const cmd = `
        SYS_USER=${shellSingleQuote(systemUser)}
        DOM=${shellSingleQuote(domain)}
        WCONF="/usr/local/hestia/data/users/$SYS_USER/web.conf"
        if [ -f "$WCONF" ]; then
          LINE=$(grep -F "DOMAIN='$DOM'" "$WCONF" | head -n1 || true)
          if [ -n "$LINE" ]; then
            CDOC=$(printf "%s" "$LINE" | sed -n "s/.*CUSTOM_DOCROOT='\\([^']*\\)'.*/\\1/p")
            [ -n "$CDOC" ] && echo "$CDOC" && exit 0
          fi
        fi
        USER_HOME=$(getent passwd "$SYS_USER" 2>/dev/null | cut -d: -f6 || true)
        [ -z "$USER_HOME" ] && USER_HOME="/home/$SYS_USER"
        echo "$USER_HOME/web/$DOM/public_html"
      `;
      const res = await execRemoteSSH(server, cmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/home/${systemUser}/web/${domain}/public_html`;
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

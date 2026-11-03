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
import {
  buildPinnedCurrentDirPermissionCommand,
  finalizeDiscoveredDomains,
  type PanelAdapter,
} from './base';

export class CloudPanelAdapter implements PanelAdapter {
  readonly panelType = 'CLOUDPANEL' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const script = `
      if [ -f /root/.my.cnf ] && mysql --defaults-extra-file=/root/.my.cnf -e "SELECT 1" >/dev/null 2>&1; then
        echo "MODE_ROOT_CNF"
      elif [ -f /etc/mysql/debian.cnf ] && mysql --defaults-extra-file=/etc/mysql/debian.cnf -e "SELECT 1" >/dev/null 2>&1; then
        echo "MODE_DEBIAN_CNF"
      elif mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
        echo "MODE_SOCKET_ROOT"
      else
        echo "ERR_NO_MYSQL_AUTH"
        exit 1
      fi
    `;
    const res = await execRemoteSSH(server, script, { zeroImpact: true });
    if (res.code !== 0 || res.stdout.includes('ERR_NO_MYSQL_AUTH')) {
      throw new Error(
        `Không thể xác thực MySQL/MariaDB Admin trên CloudPanel ${server.hostname}: ${res.stderr}`
      );
    }

    const mode = res.stdout.trim().split(/\r?\n/)[0];
    if (mode === 'MODE_ROOT_CNF') {
      return { user: 'root', defaultsFile: '/root/.my.cnf' };
    }
    if (mode === 'MODE_DEBIAN_CNF') {
      return { user: 'debian-sys-maint', defaultsFile: '/etc/mysql/debian.cnf' };
    }
    return { user: 'root' };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const pyScript = `
import json, os, sqlite3

db_path = '/home/clp/htdocs/app/data/db.sq3'
if not os.path.isfile(db_path):
    raise SystemExit('ERR_NO_CLP_DB')

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

def col_names(tbl):
    if tbl not in tables:
        return set()
    return {r[1] for r in cur.execute(f"PRAGMA table_info({tbl})").fetchall()}

site_cols = col_names('site')
dom_col = 'domain_name' if 'domain_name' in site_cols else ('domainName' if 'domainName' in site_cols else 'domain')
user_col = 'user' if 'user' in site_cols else 'system_user'
root_col = 'root_directory' if 'root_directory' in site_cols else ('rootDirectory' if 'rootDirectory' in site_cols else None)
php_id_col = 'php_settings_id' if 'php_settings_id' in site_cols else None

php_map = {}
if 'php_settings' in tables:
    pcols = col_names('php_settings')
    vcol = 'version' if 'version' in pcols else ('php_version' if 'php_version' in pcols else None)
    if vcol:
        for pr in cur.execute(f"SELECT id, {vcol} AS v FROM php_settings").fetchall():
            php_map[pr['id']] = str(pr['v'] or '')

sel_parts = ['id', f'{dom_col} AS dom', f'{user_col} AS suser']
if root_col:
    sel_parts.append(f'{root_col} AS rdir')
if php_id_col:
    sel_parts.append(f'{php_id_col} AS pid')

sites = [dict(r) for r in cur.execute(f"SELECT {', '.join(sel_parts)} FROM site ORDER BY id ASC").fetchall()]

dbs_by_site = {}
if 'database' in tables:
    dcols = col_names('database')
    sid_col = 'site_id' if 'site_id' in dcols else ('siteId' if 'siteId' in dcols else None)
    dname_col = 'name' if 'name' in dcols else ('database_name' if 'database_name' in dcols else None)
    if sid_col and dname_col:
        db_user_map = {}
        if 'database_user' in tables:
            ucols = col_names('database_user')
            did_col = 'database_id' if 'database_id' in ucols else None
            uname_col = 'user_name' if 'user_name' in ucols else ('name' if 'name' in ucols else None)
            if did_col and uname_col:
                for ur in cur.execute(f"SELECT {did_col} AS did, {uname_col} AS u FROM database_user").fetchall():
                    if ur['did'] not in db_user_map and ur['u']:
                        db_user_map[ur['did']] = ur['u']

        for dr in cur.execute(f"SELECT id, {sid_col} AS sid, {dname_col} AS dname FROM database").fetchall():
            sid = dr['sid']
            dname = (dr['dname'] or '').strip()
            if not dname:
                continue
            dbs_by_site.setdefault(sid, []).append({
                'name': dname,
                'user': db_user_map.get(dr['id']),
                'engine': 'MYSQL'
            })

all_doms = [(s.get('dom') or '').strip().lower() for s in sites if s.get('dom')]
out = []
for s in sites:
    dom = (s.get('dom') or '').strip()
    suser = (s.get('suser') or '').strip()
    if not dom or not suser or suser == 'clp':
        continue
    webroot = (s.get('rdir') or f'/home/{suser}/htdocs/{dom}').strip().rstrip('/')
    php_ver = php_map.get(s.get('pid')) if s.get('pid') else ''
    php_label = f'CloudPanel PHP {php_ver}' if php_ver else 'CloudPanel-App'

    parent_dom = None
    dlow = dom.lower()
    for cand in all_doms:
        if cand != dlow and dlow.endswith('.' + cand):
            if parent_dom is None or len(cand) > len(parent_dom):
                parent_dom = cand

    site_dbs = []
    for db_item in dbs_by_site.get(s['id'], []):
        site_dbs.append({
            'name': db_item['name'],
            'user': db_item.get('user') or suser,
            'engine': 'MYSQL'
        })

    out.append({
        'domain': dom,
        'systemUser': suser,
        'webroot': webroot,
        'phpVersion': php_label,
        'isSubdomain': bool(parent_dom),
        'parentDomain': parent_dom,
        'databases': site_dbs
    })

print(json.dumps(out))
`;

    const res = await execRemoteSSH(
      server,
      `python3 -c ${shellSingleQuote(pyScript)}`,
      { zeroImpact: true, timeoutMs: 60000 }
    );
    if (res.code !== 0) {
      throw new Error(
        `Lỗi đọc SQLite db.sq3 trên CloudPanel ${server.hostname}: ${res.stderr}`
      );
    }

    const parsed = JSON.parse(res.stdout.trim() || '[]') as DiscoveredDomain[];
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
      const pyScript = `
import os, sqlite3
db_path = '/home/clp/htdocs/app/data/db.sq3'
if os.path.isfile(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(site)").fetchall()}
    dcol = 'domain_name' if 'domain_name' in cols else 'domainName'
    rcol = 'root_directory' if 'root_directory' in cols else ('rootDirectory' if 'rootDirectory' in cols else None)
    if rcol:
        row = cur.execute(f"SELECT {rcol} FROM site WHERE {dcol} = ? LIMIT 1", (${JSON.stringify(
          domain
        )},)).fetchone()
        if row and row[0]:
            print(row[0])
            raise SystemExit(0)
`;
      const cmd = `
        OUT=$(python3 -c ${shellSingleQuote(pyScript)} 2>/dev/null || true)
        if [ -n "$OUT" ]; then echo "$OUT"; exit 0; fi
        SYS_USER=${shellSingleQuote(systemUser)}
        DOM=${shellSingleQuote(domain)}
        USER_HOME=$(getent passwd "$SYS_USER" 2>/dev/null | cut -d: -f6 || true)
        [ -z "$USER_HOME" ] && USER_HOME="/home/$SYS_USER"
        echo "$USER_HOME/htdocs/$DOM"
      `;
      const res = await execRemoteSSH(server, cmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/home/${systemUser}/htdocs/${domain}`;
  }

  buildPermissionFixCommand(
    systemUser: string,
    _domain: string,
    targetWebroot: string
  ): string {
    assertSafe(isSafeSystemUser, systemUser, 'systemUser');
    return buildPinnedCurrentDirPermissionCommand(
      targetWebroot,
      `chown -hR ${shellSingleQuote(`${systemUser}:${systemUser}`)} .`
    );
  }
}

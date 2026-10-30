import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class AaPanelAdapter implements PanelAdapter {
  readonly panelType = 'AAPANEL' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const pyScript = `
import sqlite3
conn = sqlite3.connect('/www/server/panel/data/default.db')
cur = conn.cursor()
cur.execute("SELECT mysql_root FROM config WHERE id=1")
row = cur.fetchone()
print(row[0] if row else "")
`;
    const cmd = `
      PY="/www/server/panel/pyenv/bin/python3"
      [ ! -x "$PY" ] && PY="python3"
      "$PY" -c ${shellSingleQuote(pyScript)}
    `;
    const res = await execRemoteSSH(server, cmd, { zeroImpact: true });
    if (res.code !== 0) {
      throw new Error(
        `Không đọc được mật khẩu mysql_root từ /www/server/panel/data/default.db trên aaPanel ${server.hostname}: ${res.stderr}`
      );
    }
    return {
      user: 'root',
      password: res.stdout.trim(),
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const pyScript = `
import sqlite3, json, os
conn = sqlite3.connect('/www/server/panel/data/default.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()
cur.execute("SELECT id, name, path FROM sites WHERE IFNULL(project_type,'PHP') IN ('PHP', 'WP2', 'HTML', '')")
sites = [dict(r) for r in cur.fetchall()]
cur.execute("SELECT name, username, pid FROM databases WHERE LOWER(IFNULL(type,'mysql'))='mysql'")
dbs = [dict(r) for r in cur.fetchall()]

bindings = []
try:
    cur.execute("SELECT id, pid, domain, path FROM binding")
    bindings = [dict(r) for r in cur.fetchall()]
except Exception:
    bindings = []

site_names = [s['name'].strip().lower() for s in sites if s.get('name')]
out = []
assigned_dbs = set()

for s in sites:
    sname = (s.get('name') or '').strip()
    if not sname:
        continue
    site_dbs = []
    for d in dbs:
        if d.get('pid') == s['id']:
            site_dbs.append({'name': d['name'], 'user': d.get('username') or 'www'})
            assigned_dbs.add(d['name'])
    parent_dom = None
    for cand in site_names:
        if cand != sname.lower() and sname.lower().endswith('.' + cand):
            parent_dom = cand
            break
    base_path = (s.get('path') or ('/www/wwwroot/' + sname)).rstrip('/')
    out.append({
        'domain': sname,
        'systemUser': 'www',
        'webroot': base_path,
        'phpVersion': 'aaPanel-PHP',
        'isSubdomain': bool(parent_dom),
        'parentDomain': parent_dom,
        'databases': site_dbs
    })

    # Quét Subdomain gắn thư mục con (Subdirectory Binding trên aaPanel)
    for b in bindings:
        if b.get('pid') == s['id']:
            bdom = (b.get('domain') or '').strip()
            bpath = (b.get('path') or '').strip().strip('/')
            if not bdom:
                continue
            full_bpath = os.path.join(base_path, bpath) if bpath else base_path
            out.append({
                'domain': bdom,
                'systemUser': 'www',
                'webroot': full_bpath,
                'phpVersion': 'aaPanel-PHP',
                'isSubdomain': True,
                'parentDomain': sname,
                'databases': []
            })

if out:
    for d in dbs:
        if d['name'] not in assigned_dbs:
            out[0]['databases'].append({'name': d['name'], 'user': d.get('username') or 'www'})

print(json.dumps(out))
`;
    const cmd = `
      PY="/www/server/panel/pyenv/bin/python3"
      [ ! -x "$PY" ] && PY="python3"
      "$PY" -c ${shellSingleQuote(pyScript)}
    `;
    const res = await execRemoteSSH(server, cmd, {
      zeroImpact: true,
      timeoutMs: 60000,
    });
    if (res.code !== 0) {
      throw new Error(
        `Lỗi quét SQLite default.db trên aaPanel ${server.hostname}: ${res.stderr}`
      );
    }

    const parsed = JSON.parse(res.stdout.trim() || '[]') as DiscoveredDomain[];
    return finalizeDiscoveredDomains(parsed);
  }

  async resolveTargetWebroot(
    server: ServerRecord,
    _systemUser: string,
    domain: string
  ): Promise<string> {
    if (!server.is_mock) {
      const pyScript = `
import sqlite3, os
conn = sqlite3.connect('/www/server/panel/data/default.db')
cur = conn.cursor()
cur.execute("SELECT path FROM sites WHERE name=? LIMIT 1", (${JSON.stringify(domain)},))
row = cur.fetchone()
if row and row[0]:
    print(row[0])
    raise SystemExit(0)
try:
    cur.execute("SELECT s.path, b.path FROM binding b JOIN sites s ON b.pid = s.id WHERE b.domain=? LIMIT 1", (${JSON.stringify(domain)},))
    brow = cur.fetchone()
    if brow and brow[0]:
        sub = (brow[1] or '').strip('/')
        print(os.path.join(brow[0], sub) if sub else brow[0])
        raise SystemExit(0)
except Exception:
    pass
print('/www/wwwroot/' + ${JSON.stringify(domain)})
`;
      const cmd = `
        PY="/www/server/panel/pyenv/bin/python3"
        [ ! -x "$PY" ] && PY="python3"
        "$PY" -c ${shellSingleQuote(pyScript)}
      `;
      const res = await execRemoteSSH(server, cmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/www/wwwroot/${domain}`;
  }

  buildPermissionFixCommand(
    _systemUser: string,
    _domain: string,
    targetWebroot: string
  ): string {
    return `chown -R www:www ${shellSingleQuote(targetWebroot)} && chmod -R 755 ${shellSingleQuote(
      targetWebroot
    )}`;
  }
}

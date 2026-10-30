import { execRemoteSSH, shellSingleQuote } from '@/lib/ssh';
import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  ServerRecord,
} from '@/types';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class DirectAdminAdapter implements PanelAdapter {
  readonly panelType = 'DIRECTADMIN' as const;

  async getMysqlAdminCredentials(
    server: ServerRecord
  ): Promise<MysqlAdminCredentials> {
    const script = `
      CONF="/usr/local/directadmin/conf/mysql.conf"
      if [ ! -f "$CONF" ]; then
        echo "ERR_NO_CONF"
        exit 1
      fi
      U=$(grep -E '^user=' "$CONF" | head -n1 | cut -d= -f2-)
      P=$(grep -E '^passwd=' "$CONF" | head -n1 | cut -d= -f2-)
      printf "%s\\n%s\\n" "$U" "$P"
    `;
    const res = await execRemoteSSH(server, script, { zeroImpact: true });
    if (res.code !== 0 || res.stdout.includes('ERR_NO_CONF')) {
      throw new Error(
        `Không đọc được /usr/local/directadmin/conf/mysql.conf trên ${server.hostname}: ${res.stderr}`
      );
    }
    const [user, password] = res.stdout.split('\n');
    return {
      user: (user || 'da_admin').trim(),
      password: (password || '').trim(),
    };
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    const creds = await this.getMysqlAdminCredentials(server);
    const escapedPass = (creds.password || '').replace(/'/g, `'\\''`);

    const script = `
      ALL_DBS=$(MYSQL_PWD='${escapedPass}' mysql -u"${creds.user}" -N -B -e "SHOW DATABASES;" 2>/dev/null | grep -Ev '^(information_schema|performance_schema|mysql|sys)$' || true)
      DA_SUB_IN_DOMAINS=$(grep -E '^(create_subdomain_docroot_in_domains_dir|subdomain_docroot_in_domains_dir)=1' /usr/local/directadmin/conf/directadmin.conf 2>/dev/null | head -n1 || true)

      detect_dbs_in_webroot() {
        wroot="$1"
        udbs="$2"
        [ -z "$udbs" ] && return 0
        [ ! -d "$wroot" ] && return 0
        cfg_blob=""
        for cf in "$wroot/wp-config.php" "$wroot/.env" "$wroot/configuration.php" "$wroot/config.php" "$wroot/src/config.php"; do
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

      for dlist in /usr/local/directadmin/data/users/*/domains.list; do
        [ -f "$dlist" ] || continue
        user_dir=$(dirname "$dlist")
        sys_user=$(basename "$user_dir")
        user_dbs=$(printf "%s\\n" "$ALL_DBS" | grep -E "^$\{sys_user}_" | paste -sd "," - || true)
        printf "USERDBS|%s|%s\\n" "$sys_user" "$user_dbs"

        while IFS= read -r dom || [ -n "$dom" ]; do
          dom=$(printf "%s" "$dom" | tr -d '\\r\\n ')
          [ -z "$dom" ] && continue
          webroot="/home/$sys_user/domains/$dom/public_html"
          php_ver="8.1"
          conf_file="$user_dir/domains/$dom.conf"
          if [ -f "$conf_file" ]; then
            custom_doc=$(grep -E '^document_root=' "$conf_file" | head -n1 | cut -d= -f2- | tr -d '\\r\\n')
            if [ -n "$custom_doc" ]; then
              case "$custom_doc" in
                /home/*) webroot="$custom_doc" ;;
                /*) webroot="/home/$sys_user$custom_doc" ;;
                *) webroot="/home/$sys_user/$custom_doc" ;;
              esac
            fi
            pver=$(grep -E '^php1_select=' "$conf_file" | head -n1 | cut -d= -f2- | tr -d '\\r\\n')
            [ -n "$pver" ] && php_ver="PHP-Select-$pver"
          fi

          dom_dbs=$(detect_dbs_in_webroot "$webroot" "$user_dbs")
          printf "ROW|%s|%s|%s|%s|0||%s\\n" "$dom" "$sys_user" "$webroot" "$php_ver" "$dom_dbs"

          # Quét đầy đủ Subdomains của user trong <domain>.subdomains
          sub_list_file="$user_dir/domains/$dom.subdomains"
          ov_file="$user_dir/domains/$dom.subdomains.docroot.override"
          if [ -f "$sub_list_file" ]; then
            while IFS= read -r sub || [ -n "$sub" ]; do
              sub=$(printf "%s" "$sub" | tr -d '\\r\\n ')
              [ -z "$sub" ] && continue
              full_sub="$\{sub}.$\{dom}"
              sub_webroot=""
              sub_php="$php_ver"

              if [ -f "$ov_file" ]; then
                ov_line=$(grep -E "^$\{sub}=" "$ov_file" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '\\r\\n' || true)
                if [ -n "$ov_line" ]; then
                  pub_raw=$(printf "%s" "$ov_line" | tr '&' '\\n' | grep -E '^public_html=' | head -n1 | cut -d= -f2- || true)
                  p1_raw=$(printf "%s" "$ov_line" | tr '&' '\\n' | grep -E '^php1_select=' | head -n1 | cut -d= -f2- || true)
                  if [ -n "$pub_raw" ]; then
                    decoded=$(/usr/bin/printf '%b' "$(printf '%s' "$pub_raw" | sed 's/+/ /g; s/%/\\\\x/g')" 2>/dev/null || printf '%s' "$pub_raw" | sed 's/%2F/\\//gi; s/%20/ /g')
                    case "$decoded" in
                      /home/*) sub_webroot="$decoded" ;;
                      /*) sub_webroot="/home/$sys_user$decoded" ;;
                      *) sub_webroot="/home/$sys_user/$decoded" ;;
                    esac
                  fi
                  [ -n "$p1_raw" ] && sub_php="PHP-Select-$p1_raw"
                fi
              fi

              if [ -z "$sub_webroot" ]; then
                cand_modern="/home/$sys_user/domains/$full_sub/public_html"
                cand_legacy="/home/$sys_user/domains/$dom/public_html/$sub"
                if [ -d "$cand_modern" ] && [ ! -d "$cand_legacy" ]; then
                  sub_webroot="$cand_modern"
                elif [ -d "$cand_legacy" ] && [ ! -d "$cand_modern" ]; then
                  sub_webroot="$cand_legacy"
                elif grep -Fq "$cand_modern" "$user_dir/httpd.conf" "$user_dir/nginx.conf" "$user_dir/openlitespeed.conf" 2>/dev/null; then
                  sub_webroot="$cand_modern"
                elif [ -d "$cand_modern" ] || [ -n "$DA_SUB_IN_DOMAINS" ]; then
                  sub_webroot="$cand_modern"
                else
                  sub_webroot="$cand_legacy"
                fi
              fi

              sub_dbs=$(detect_dbs_in_webroot "$sub_webroot" "$user_dbs")
              printf "ROW|%s|%s|%s|%s|1|%s|%s\\n" "$full_sub" "$sys_user" "$sub_webroot" "$sub_php" "$dom" "$sub_dbs"
            done < "$sub_list_file"
          fi
        done < "$dlist"
      done
    `;

    const res = await execRemoteSSH(server, script, {
      zeroImpact: true,
      timeoutMs: 90000,
    });
    if (res.code !== 0) {
      throw new Error(
        `Lỗi quét danh sách domain/subdomain DirectAdmin trên ${server.hostname}: ${res.stderr}`
      );
    }

    const userAllDbs = new Map<string, string[]>();
    const claimedUserDbs = new Map<string, Set<string>>();
    const rawOut: DiscoveredDomain[] = [];

    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('USERDBS|')) {
        const [, sysUser, dbsCsv] = line.split('|');
        if (sysUser) {
          const list = (dbsCsv || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          userAllDbs.set(sysUser.trim(), list);
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
        phpVersion: (phpVersion || '8.1').trim(),
        isSubdomain: isSubFlag === '1',
        parentDomain: parentDom?.trim() || undefined,
        databases: siteDbs,
      });
    }

    // Đảm bảo mọi DB chưa khớp file cấu hình vẫn được gán vào domain đầu tiên của user (không bỏ sót bất kỳ DB nào)
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
      const checkCmd = `
        USER_DIR="/usr/local/directadmin/data/users/${systemUser}"
        CONF="$USER_DIR/domains/${domain}.conf"
        if [ -f "$CONF" ]; then
          DOC=$(grep -E '^document_root=' "$CONF" | head -n1 | cut -d= -f2- | tr -d '\\r\\n')
          if [ -n "$DOC" ]; then
            case "$DOC" in
              /home/*) echo "$DOC"; exit 0 ;;
              /*) echo "/home/${systemUser}$DOC"; exit 0 ;;
              *) echo "/home/${systemUser}/$DOC"; exit 0 ;;
            esac
          fi
          echo "/home/${systemUser}/domains/${domain}/public_html"
          exit 0
        fi

        # Kiểm tra nếu domain là Subdomain của một domain cha thuộc user
        for subf in "$USER_DIR"/domains/*.subdomains; do
          [ -f "$subf" ] || continue
          pdom=$(basename "$subf" .subdomains)
          case "${domain}" in
            *."$pdom")
              sub_prefix=$(printf "%s" "${domain}" | sed "s/\\.$pdom\$//")
              ovf="$USER_DIR/domains/$pdom.subdomains.docroot.override"
              if [ -f "$ovf" ]; then
                ov_line=$(grep -E "^$\{sub_prefix}=" "$ovf" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '\\r\\n' || true)
                pub_raw=$(printf "%s" "$ov_line" | tr '&' '\\n' | grep -E '^public_html=' | head -n1 | cut -d= -f2- || true)
                if [ -n "$pub_raw" ]; then
                  decoded=$(/usr/bin/printf '%b' "$(printf '%s' "$pub_raw" | sed 's/+/ /g; s/%/\\\\x/g')" 2>/dev/null || printf '%s' "$pub_raw" | sed 's/%2F/\\//gi; s/%20/ /g')
                  case "$decoded" in
                    /home/*) echo "$decoded"; exit 0 ;;
                    /*) echo "/home/${systemUser}$decoded"; exit 0 ;;
                    *) echo "/home/${systemUser}/$decoded"; exit 0 ;;
                  esac
                fi
              fi
              if [ -d "/home/${systemUser}/domains/${domain}/public_html" ]; then
                echo "/home/${systemUser}/domains/${domain}/public_html"
                exit 0
              fi
              if [ -d "/home/${systemUser}/domains/$pdom/public_html/$sub_prefix" ]; then
                echo "/home/${systemUser}/domains/$pdom/public_html/$sub_prefix"
                exit 0
              fi
              ;;
          esac
        done

        echo "/home/${systemUser}/domains/${domain}/public_html"
      `;
      const res = await execRemoteSSH(server, checkCmd, { zeroImpact: true });
      if (res.code === 0 && res.stdout.trim()) {
        return res.stdout.trim().split('\n')[0].trim();
      }
    }
    return `/home/${systemUser}/domains/${domain}/public_html`;
  }

  buildPermissionFixCommand(
    systemUser: string,
    _domain: string,
    targetWebroot: string
  ): string {
    return `chown -R ${shellSingleQuote(`${systemUser}:${systemUser}`)} ${shellSingleQuote(
      targetWebroot
    )}`;
  }
}

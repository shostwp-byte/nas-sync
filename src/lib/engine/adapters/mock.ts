import type {
  DiscoveredDomain,
  MysqlAdminCredentials,
  PanelType,
  ServerRecord,
} from '@/types';
import { finalizeDiscoveredDomains, type PanelAdapter } from './base';

export class MockPanelAdapter implements PanelAdapter {
  readonly panelType: PanelType;

  constructor(panelType: PanelType) {
    this.panelType = panelType;
  }

  async getMysqlAdminCredentials(): Promise<MysqlAdminCredentials> {
    switch (this.panelType) {
      case 'DIRECTADMIN':
        return { user: 'da_admin', password: 'mock_da_admin_password' };
      case 'CPANEL':
        return { user: 'root', defaultsFile: '/root/.my.cnf' };
      case 'PLESK':
        return { user: 'admin', password: 'mock_psa_shadow_password' };
      case 'AAPANEL':
        return { user: 'root', password: 'mock_aapanel_mysql_root' };
    }
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    await new Promise((r) => setTimeout(r, 250));
    const slug = server.hostname.split('.')[0].replace(/[^a-z0-9]/gi, '');

    if (this.panelType === 'DIRECTADMIN') {
      return finalizeDiscoveredDomains([
        {
          domain: 'portal-demo.vn',
          systemUser: 'portalvn',
          webroot: '/home/portalvn/domains/portal-demo.vn/public_html',
          phpVersion: 'PHP 8.2 (FPM)',
          databases: [
            { name: 'portalvn_wpcore', user: 'portalvn_wp' },
            { name: 'portalvn_billing', user: 'portalvn_bill' },
          ],
        },
        {
          domain: 'shop.portal-demo.vn',
          systemUser: 'portalvn',
          webroot: '/home/portalvn/domains/shop.portal-demo.vn/public_html',
          phpVersion: 'PHP 8.2 (FPM)',
          isSubdomain: true,
          parentDomain: 'portal-demo.vn',
          databases: [{ name: 'portalvn_shop', user: 'portalvn_shop' }],
        },
        {
          domain: 'blog.portal-demo.vn',
          systemUser: 'portalvn',
          webroot: '/home/portalvn/domains/portal-demo.vn/public_html/blog',
          phpVersion: 'PHP 8.1 (FPM)',
          isSubdomain: true,
          parentDomain: 'portal-demo.vn',
          databases: [],
        },
        {
          domain: 'khachhang-crm.vn',
          systemUser: 'crmuser',
          webroot: '/home/crmuser/domains/khachhang-crm.vn/public_html',
          phpVersion: 'PHP 8.3 (FPM)',
          databases: [{ name: 'crmuser_prod', user: 'crmuser_app' }],
        },
      ]);
    }

    if (this.panelType === 'CPANEL') {
      return finalizeDiscoveredDomains([
        {
          domain: 'shopthoitrang.vn',
          systemUser: 'shoptt',
          webroot: '/home/shoptt/public_html',
          phpVersion: 'ea-php82',
          databases: [{ name: 'shoptt_woocommerce', user: 'shoptt_admin' }],
        },
        {
          domain: 'api.shopthoitrang.vn',
          systemUser: 'shoptt',
          webroot: '/home/shoptt/api.shopthoitrang.vn',
          phpVersion: 'ea-php82',
          isSubdomain: true,
          parentDomain: 'shopthoitrang.vn',
          databases: [{ name: 'shoptt_api', user: 'shoptt_api' }],
        },
        {
          domain: 'tintuc24h.net.vn',
          systemUser: 'tintuc24',
          webroot: '/home/tintuc24/public_html',
          phpVersion: 'ea-php81',
          databases: [{ name: 'tintuc24_cms', user: 'tintuc24_db' }],
        },
      ]);
    }

    if (this.panelType === 'PLESK') {
      return finalizeDiscoveredDomains([
        {
          domain: 'doanhnghiep-erp.vn',
          systemUser: 'erp_sys',
          webroot: '/var/www/vhosts/doanhnghiep-erp.vn/httpdocs',
          phpVersion: 'plesk-php82-fpm',
          databases: [{ name: 'erp_production_db', user: 'erp_dbuser' }],
        },
        {
          domain: 'crm.doanhnghiep-erp.vn',
          systemUser: 'erp_sys',
          webroot: '/var/www/vhosts/doanhnghiep-erp.vn/crm.doanhnghiep-erp.vn',
          phpVersion: 'plesk-php82-fpm',
          isSubdomain: true,
          parentDomain: 'doanhnghiep-erp.vn',
          databases: [{ name: 'erp_crm_sub', user: 'erp_dbuser' }],
        },
      ]);
    }

    return finalizeDiscoveredDomains([
      {
        domain: `portal-${slug}.vn`,
        systemUser: 'www',
        webroot: `/www/wwwroot/portal-${slug}.vn`,
        phpVersion: 'aaPanel-PHP-82',
        databases: [{ name: `sql_portal_${slug}`, user: `portal_${slug}` }],
      },
      {
        domain: `sub.portal-${slug}.vn`,
        systemUser: 'www',
        webroot: `/www/wwwroot/portal-${slug}.vn/sub`,
        phpVersion: 'aaPanel-PHP-82',
        isSubdomain: true,
        parentDomain: `portal-${slug}.vn`,
        databases: [],
      },
    ]);
  }

  async resolveTargetWebroot(
    _server: ServerRecord,
    systemUser: string,
    domain: string
  ): Promise<string> {
    switch (this.panelType) {
      case 'DIRECTADMIN':
        return `/home/${systemUser}/domains/${domain}/public_html`;
      case 'CPANEL':
        return `/home/${systemUser}/${domain}`;
      case 'PLESK':
        return `/var/www/vhosts/${domain}/httpdocs`;
      case 'AAPANEL':
        return `/www/wwwroot/${domain}`;
    }
  }

  buildPermissionFixCommand(
    systemUser: string,
    domain: string,
    targetWebroot: string
  ): string {
    switch (this.panelType) {
      case 'DIRECTADMIN':
        return `chown -R ${systemUser}:${systemUser} ${targetWebroot}`;
      case 'CPANEL':
        return `chown -R ${systemUser}:${systemUser} ${targetWebroot}`;
      case 'PLESK':
        return `plesk repair fs ${domain} -y`;
      case 'AAPANEL':
        return `chown -R www:www ${targetWebroot}`;
    }
  }
}

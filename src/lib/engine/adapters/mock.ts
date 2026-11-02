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
      case 'CYBERPANEL':
        return { user: 'root', password: 'mock_cyberpanel_mysql_pass' };
      case 'HESTIACP':
        return { user: 'root', password: 'mock_hestia_mysql_pass' };
      case 'CLOUDPANEL':
        return { user: 'root' };
    }
  }

  async discoverDomains(server: ServerRecord): Promise<DiscoveredDomain[]> {
    await new Promise((r) => setTimeout(r, 250));
    const slug = server.hostname.split('.')[0].replace(/[^a-z0-9]/gi, '') || 'demo';

    if (this.panelType === 'DIRECTADMIN') {
      return finalizeDiscoveredDomains([
        {
          domain: 'portal-demo.vn',
          systemUser: 'portalvn',
          webroot: '/home/portalvn/domains/portal-demo.vn/public_html',
          phpVersion: 'PHP 8.2 (FPM)',
          databases: [
            { name: 'portalvn_wpcore', user: 'portalvn_wp', engine: 'MYSQL' },
            { name: 'portalvn_billing', user: 'portalvn_bill', engine: 'MYSQL' },
          ],
        },
        {
          domain: 'shop.portal-demo.vn',
          systemUser: 'portalvn',
          webroot: '/home/portalvn/domains/shop.portal-demo.vn/public_html',
          phpVersion: 'PHP 8.2 (FPM)',
          isSubdomain: true,
          parentDomain: 'portal-demo.vn',
          databases: [{ name: 'portalvn_shop', user: 'portalvn_shop', engine: 'MYSQL' }],
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
          databases: [{ name: 'crmuser_prod', user: 'crmuser_app', engine: 'MYSQL' }],
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
          databases: [{ name: 'shoptt_woocommerce', user: 'shoptt_admin', engine: 'MYSQL' }],
        },
        {
          domain: 'api.shopthoitrang.vn',
          systemUser: 'shoptt',
          webroot: '/home/shoptt/api.shopthoitrang.vn',
          phpVersion: 'ea-php82',
          isSubdomain: true,
          parentDomain: 'shopthoitrang.vn',
          databases: [{ name: 'shoptt_api', user: 'shoptt_api', engine: 'MYSQL' }],
        },
        {
          domain: 'tintuc24h.net.vn',
          systemUser: 'tintuc24',
          webroot: '/home/tintuc24/public_html',
          phpVersion: 'ea-php81',
          databases: [{ name: 'tintuc24_cms', user: 'tintuc24_db', engine: 'MYSQL' }],
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
          databases: [
            { name: 'erp_production_db', user: 'erp_dbuser', engine: 'MYSQL' },
            { name: 'erp_analytics_pg', user: 'erp_dbuser', engine: 'POSTGRESQL' },
          ],
        },
        {
          domain: 'crm.doanhnghiep-erp.vn',
          systemUser: 'erp_sys',
          webroot: '/var/www/vhosts/doanhnghiep-erp.vn/crm.doanhnghiep-erp.vn',
          phpVersion: 'plesk-php82-fpm',
          isSubdomain: true,
          parentDomain: 'doanhnghiep-erp.vn',
          databases: [{ name: 'erp_crm_sub', user: 'erp_dbuser', engine: 'MYSQL' }],
        },
      ]);
    }

    if (this.panelType === 'CYBERPANEL') {
      return finalizeDiscoveredDomains([
        {
          domain: 'cyber-store.vn',
          systemUser: 'cybershop',
          webroot: '/home/cyber-store.vn/public_html',
          phpVersion: 'PHP 8.2 (LiteSpeed)',
          databases: [
            { name: 'cybershop_wp', user: 'cybershop_usr', engine: 'MYSQL' },
          ],
        },
        {
          domain: 'cdn.cyber-store.vn',
          systemUser: 'cybershop',
          webroot: '/home/cyber-store.vn/cdn.cyber-store.vn',
          phpVersion: 'PHP 8.2 (LiteSpeed)',
          isSubdomain: true,
          parentDomain: 'cyber-store.vn',
          databases: [],
        },
      ]);
    }

    if (this.panelType === 'HESTIACP') {
      return finalizeDiscoveredDomains([
        {
          domain: 'saas-platform.vn',
          systemUser: 'hestiausr',
          webroot: '/home/hestiausr/web/saas-platform.vn/public_html',
          phpVersion: 'PHP-8_3',
          databases: [
            { name: 'hestiausr_core', user: 'hestiausr_app', engine: 'MYSQL' },
            { name: 'hestiausr_pgdata', user: 'hestiausr_pg', engine: 'POSTGRESQL' },
          ],
        },
        {
          domain: 'app.saas-platform.vn',
          systemUser: 'hestiausr',
          webroot: '/home/hestiausr/web/app.saas-platform.vn/public_html',
          phpVersion: 'PHP-8_3',
          isSubdomain: true,
          parentDomain: 'saas-platform.vn',
          databases: [{ name: 'hestiausr_tenant', user: 'hestiausr_app', engine: 'MYSQL' }],
        },
      ]);
    }

    if (this.panelType === 'CLOUDPANEL') {
      return finalizeDiscoveredDomains([
        {
          domain: 'cloud-commerce.vn',
          systemUser: 'clp_shopvn',
          webroot: '/home/clp_shopvn/htdocs/cloud-commerce.vn',
          phpVersion: 'CloudPanel PHP 8.3',
          databases: [
            { name: 'clp_shopvn_prod', user: 'clp_shopvn_db', engine: 'MYSQL' },
          ],
        },
        {
          domain: 'api.cloud-commerce.vn',
          systemUser: 'clp_shopvn',
          webroot: '/home/clp_shopvn/htdocs/api.cloud-commerce.vn',
          phpVersion: 'CloudPanel PHP 8.3',
          isSubdomain: true,
          parentDomain: 'cloud-commerce.vn',
          databases: [{ name: 'clp_shopvn_api', user: 'clp_shopvn_db', engine: 'MYSQL' }],
        },
      ]);
    }

    return finalizeDiscoveredDomains([
      {
        domain: `portal-${slug}.vn`,
        systemUser: 'www',
        webroot: `/www/wwwroot/portal-${slug}.vn`,
        phpVersion: 'aaPanel-PHP-82',
        databases: [{ name: `sql_portal_${slug}`, user: `portal_${slug}`, engine: 'MYSQL' }],
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
      case 'CYBERPANEL':
        return `/home/${domain}/public_html`;
      case 'HESTIACP':
        return `/home/${systemUser}/web/${domain}/public_html`;
      case 'CLOUDPANEL':
        return `/home/${systemUser}/htdocs/${domain}`;
    }
  }

  buildPermissionFixCommand(
    systemUser: string,
    domain: string,
    targetWebroot: string
  ): string {
    switch (this.panelType) {
      case 'DIRECTADMIN':
      case 'CPANEL':
      case 'CYBERPANEL':
      case 'HESTIACP':
      case 'CLOUDPANEL':
        return `chown -hR ${systemUser}:${systemUser} ${targetWebroot}`;
      case 'PLESK':
        return `plesk repair fs ${domain} -y`;
      case 'AAPANEL':
        return `chown -hR www:www ${targetWebroot}`;
    }
  }
}

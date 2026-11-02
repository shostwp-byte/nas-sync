import type { ServerRecord } from '@/types';
import { AaPanelAdapter } from './aapanel';
import type { PanelAdapter } from './base';
import { CloudPanelAdapter } from './cloudpanel';
import { CPanelAdapter } from './cpanel';
import { CyberPanelAdapter } from './cyberpanel';
import { DirectAdminAdapter } from './directadmin';
import { HestiaCpAdapter } from './hestiacp';
import { MockPanelAdapter } from './mock';
import { PleskAdapter } from './plesk';

export function getPanelAdapter(server: ServerRecord): PanelAdapter {
  if (server.is_mock) {
    return new MockPanelAdapter(server.panel_type);
  }
  switch (server.panel_type) {
    case 'DIRECTADMIN':
      return new DirectAdminAdapter();
    case 'CPANEL':
      return new CPanelAdapter();
    case 'PLESK':
      return new PleskAdapter();
    case 'AAPANEL':
      return new AaPanelAdapter();
    case 'CYBERPANEL':
      return new CyberPanelAdapter();
    case 'HESTIACP':
      return new HestiaCpAdapter();
    case 'CLOUDPANEL':
      return new CloudPanelAdapter();
    default:
      return new DirectAdminAdapter();
  }
}

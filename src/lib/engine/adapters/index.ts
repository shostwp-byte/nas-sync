import type { ServerRecord } from '@/types';
import { AaPanelAdapter } from './aapanel';
import type { PanelAdapter } from './base';
import { CPanelAdapter } from './cpanel';
import { DirectAdminAdapter } from './directadmin';
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
    default:
      return new DirectAdminAdapter();
  }
}


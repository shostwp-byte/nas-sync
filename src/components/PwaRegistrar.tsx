'use client';

import { useEffect } from 'react';

export function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        // Silently ignore SW registration errors in restricted/non-HTTPS dev contexts
      });
  }, []);

  return null;
}

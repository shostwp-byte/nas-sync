import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { PwaRegistrar } from '@/components/PwaRegistrar';
import { SocketProvider } from '@/components/SocketProvider';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#020617',
};

export const metadata: Metadata = {
  title: 'NAS-Sync — Hệ thống Sao lưu & Khôi phục Đa Máy chủ Mã nguồn Mở',
  description:
    'Nền tảng sao lưu tăng dần (Incremental Hard-Link) & khôi phục chéo Control Panel chạy trên Synology NAS (MIT Open Source)',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'NAS-Sync',
  },
  icons: {
    icon: '/icons/icon-192.svg',
    apple: '/icons/apple-touch-icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" className="dark">
      <body>
        <PwaRegistrar />
        <SocketProvider>
          <AppShell>{children}</AppShell>
        </SocketProvider>
      </body>
    </html>
  );
}

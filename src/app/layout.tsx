import type { Metadata } from 'next';
import './globals.css';
import { AppShell } from '@/components/AppShell';
import { SocketProvider } from '@/components/SocketProvider';

export const metadata: Metadata = {
  title: 'NAS-Sync — Hệ thống Sao lưu & Khôi phục Đa Máy chủ Mã nguồn Mở',
  description:
    'Nền tảng sao lưu tăng dần (Incremental Hard-Link) & khôi phục chéo Control Panel chạy trên Synology NAS (MIT Open Source)',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="vi" className="dark">
      <body>
        <SocketProvider>
          <AppShell>{children}</AppShell>
        </SocketProvider>
      </body>
    </html>
  );
}

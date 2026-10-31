import './src/lib/node-polyfill';
import { createServer } from 'node:http';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { getDb } from './src/lib/db';
import { initializeQueueAndScheduler } from './src/lib/engine/queue';
import { refreshAllVolumes } from './src/lib/engine/volume-manager';
import { attachSocketIO } from './src/lib/events';
import { SESSION_COOKIE_NAME, verifySessionToken } from './src/lib/jwt-edge';
import { ensureJwtSecret } from './src/lib/jwt-secret';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);

// Phải chạy trước next()/app.prepare() để Middleware Edge nhận đúng JWT_SECRET
ensureJwtSecret();

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      const raw = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

async function bootstrap() {
  await app.prepare();

  // Khởi tạo Database SQLite & kiểm tra Volume ban đầu
  getDb();
  await refreshAllVolumes().catch((err) => {
    console.warn('[SHOST Startup] Cảnh báo kiểm tra Volume:', err);
  });

  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  // Tích hợp Socket.IO phục vụ cập nhật % tiến trình & Live Terminal Log thời gian thực.
  // Không bật CORS: giao diện Web cùng origin, cookie phiên được gửi kèm khi bắt tay.
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
  });

  // Live log / cảnh báo chứa hostname, đường dẫn & lỗi hệ thống — chỉ phát cho phiên đã đăng nhập
  io.use(async (socket, nextFn) => {
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
    const session = token ? await verifySessionToken(token) : null;
    if (!session) {
      nextFn(new Error('unauthorized'));
      return;
    }
    nextFn();
  });

  attachSocketIO(io);

  io.on('connection', (socket) => {
    socket.emit('engine:connected', {
      serverTime: new Date().toISOString(),
    });
  });

  // Khởi động BullMQ / Local Queue Worker & bộ lập lịch Cron
  await initializeQueueAndScheduler();

  httpServer.listen(port, hostname, () => {
    console.log(
      `==================================================================`
    );
    console.log(
      `🚀 SHOST Backup Platform sẵn sàng tại: http://localhost:${port}`
    );
    console.log(
      `📡 WebSocket Real-time Progress: ws://localhost:${port}/socket.io`
    );
    console.log(
      `==================================================================`
    );
  });
}

bootstrap().catch((err) => {
  console.error('[SHOST Fatal] Lỗi khởi động hệ thống:', err);
  process.exit(1);
});

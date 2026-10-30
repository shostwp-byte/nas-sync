import './src/lib/node-polyfill';
import { createServer } from 'node:http';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { getDb } from './src/lib/db';
import { initializeQueueAndScheduler } from './src/lib/engine/queue';
import { refreshAllVolumes } from './src/lib/engine/volume-manager';
import { attachSocketIO } from './src/lib/events';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = Number(process.env.PORT || 3000);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

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

  // Tích hợp Socket.IO phục vụ cập nhật % tiến trình & Live Terminal Log thời gian thực
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
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

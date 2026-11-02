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

function stripCookieFromHeader(
  header: string | undefined,
  name: string
): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return Boolean(part);
      return part.slice(0, idx).trim() !== name;
    });
  return kept.length > 0 ? kept.join('; ') : undefined;
}

function matchesSocketOrigin(origin: string, rawHostHeader: string): boolean {
  try {
    const parsed = new URL(origin);
    const originHost = parsed.host.toLowerCase();
    const firstHost = rawHostHeader.split(',')[0]?.trim().toLowerCase() || '';
    const normalizedExpected =
      parsed.protocol === 'https:'
        ? firstHost.replace(/:443$/, '')
        : parsed.protocol === 'http:'
        ? firstHost.replace(/:80$/, '')
        : firstHost;
    return Boolean(normalizedExpected) && originHost === normalizedExpected;
  } catch {
    return false;
  }
}

function isTokenVersionValidInDb(userId: number, tokenVersion?: number): boolean {
  try {
    const row = getDb()
      .prepare('SELECT id, COALESCE(token_version, 1) AS tv FROM users WHERE id = ?')
      .get(userId);
    if (!row) return false;
    return Number(row.tv ?? 1) === (tokenVersion ?? 1);
  } catch {
    return false;
  }
}

async function bootstrap() {
  await app.prepare();

  // Khởi tạo Database SQLite & kiểm tra Volume ban đầu
  getDb();
  await refreshAllVolumes().catch((err) => {
    console.warn('[NAS-Sync Startup] Cảnh báo kiểm tra Volume:', err);
  });

  const httpServer = createServer(async (req, res) => {
    try {
      // Ghi đè IP kết nối TCP thực tế để chống giả mạo X-Forwarded-For khi không bật TRUST_PROXY
      req.headers['x-nas-client-ip'] = req.socket.remoteAddress || 'unknown';

      const rawUrl = req.url || '/';
      const qIdx = rawUrl.indexOf('?');
      const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

      const skipRevocationCheck =
        pathname.startsWith('/_next') ||
        pathname === '/favicon.ico' ||
        pathname === '/api/health' ||
        pathname === '/api/auth/login' ||
        pathname === '/api/auth/logout';

      if (!skipRevocationCheck) {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
        if (token) {
          const session = await verifySessionToken(token);
          if (
            session &&
            !isTokenVersionValidInDb(session.userId, session.tokenVersion)
          ) {
            res.setHeader(
              'Set-Cookie',
              `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
            );
            if (pathname.startsWith('/api/')) {
              res.statusCode = 401;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  error:
                    'Phiên đăng nhập đã hết hạn hoặc bị thu hồi. Vui lòng đăng nhập lại.',
                })
              );
              return;
            }
            const cleanedCookie = stripCookieFromHeader(
              req.headers.cookie,
              SESSION_COOKIE_NAME
            );
            if (cleanedCookie) {
              req.headers.cookie = cleanedCookie;
            } else {
              delete req.headers.cookie;
            }
          }
        }
      }

      await handle(req, res);
    } catch (err) {
      console.error('[NAS-Sync HTTP Error]:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  });

  // Tích hợp Socket.IO phục vụ cập nhật % tiến trình & Live Terminal Log thời gian thực.
  // Không bật CORS: giao diện Web cùng origin, cookie phiên được gửi kèm khi bắt tay.
  const io = new SocketIOServer(httpServer, {
    path: '/socket.io',
  });

  // Live log / cảnh báo chứa hostname, đường dẫn & lỗi hệ thống — chỉ phát cho phiên hợp lệ & đúng Origin
  io.use(async (socket, nextFn) => {
    const origin = socket.handshake.headers.origin;
    const rawHost =
      (socket.handshake.headers['x-forwarded-host'] as string | undefined) ||
      socket.handshake.headers.host;
    if (origin && rawHost && !matchesSocketOrigin(origin, rawHost)) {
      nextFn(new Error('CSRF Origin mismatch'));
      return;
    }

    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
    const session = token ? await verifySessionToken(token) : null;
    if (
      !session ||
      !isTokenVersionValidInDb(session.userId, session.tokenVersion)
    ) {
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
      `🚀 NAS-Sync Platform sẵn sàng tại: http://localhost:${port}`
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
  console.error('[NAS-Sync Fatal] Lỗi khởi động hệ thống:', err);
  process.exit(1);
});

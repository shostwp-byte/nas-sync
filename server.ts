import './src/lib/node-polyfill';
import { createServer } from 'node:http';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { getDb } from './src/lib/db';
import { initializeQueueAndScheduler } from './src/lib/engine/queue';
import { refreshAllVolumes } from './src/lib/engine/volume-manager';
import { attachSocketIO } from './src/lib/events';
import {
  SESSION_COOKIE_NAME,
  normalizeUserRole,
  verifySessionToken,
} from './src/lib/jwt-edge';
import { ensureJwtSecret } from './src/lib/jwt-secret';
import type { UserRole } from './src/types';

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

interface LiveUserAuthState {
  id: number;
  username: string;
  role: UserRole;
  tokenVersion: number;
}

function getUserAuthStateFromDb(
  userId: number,
  tokenVersion?: number
): LiveUserAuthState | null {
  try {
    const row = getDb()
      .prepare(
        'SELECT id, username, role, COALESCE(token_version, 1) AS tv FROM users WHERE id = ?'
      )
      .get(userId);
    if (!row) return null;
    const dbTv = Number(row.tv ?? 1);
    if (dbTv !== (tokenVersion ?? 1)) {
      return null;
    }
    return {
      id: Number(row.id),
      username: String(row.username),
      role: normalizeUserRole(row.role || 'ADMIN'),
      tokenVersion: dbTv,
    };
  } catch {
    return null;
  }
}

function evaluateApiRbac(
  method: string,
  rawPathname: string,
  role: UserRole
): { allowed: boolean; error?: string } {
  const m = method.toUpperCase();
  const p =
    rawPathname.length > 1 ? rawPathname.replace(/\/+$/, '') : rawPathname;

  // 1. Public & Logout
  if (
    p === '/api/health' ||
    p === '/api/auth/login' ||
    p === '/api/auth/logout'
  ) {
    return { allowed: true };
  }

  // 2. Tài khoản cá nhân & 2FA (Mọi vai trò đã xác thực: ADMIN, OPERATOR, VIEWER)
  if (
    (p === '/api/auth/me' && (m === 'GET' || m === 'PATCH')) ||
    (p === '/api/auth/2fa' && (m === 'GET' || m === 'POST'))
  ) {
    return { allowed: true };
  }

  // 3. Xem NOC Read-Only (ADMIN, OPERATOR, VIEWER)
  if (
    m === 'GET' &&
    (p === '/api/dashboard' ||
      p === '/api/servers' ||
      p === '/api/volumes' ||
      p === '/api/jobs' ||
      /^\/api\/jobs\/[^/]+$/.test(p) ||
      p === '/api/schedules' ||
      p === '/api/restore')
  ) {
    return { allowed: true };
  }

  // 4. Quyền Vận hành viên trở lên (ADMIN + OPERATOR; chặn VIEWER)
  if (
    m === 'GET' &&
    (p === '/api/explorer/download' || p === '/api/explorer/archive')
  ) {
    if (role === 'ADMIN' || role === 'OPERATOR') {
      return { allowed: true };
    }
    return {
      allowed: false,
      error: 'Tài khoản VIEWER không có quyền tải xuống dữ liệu sao lưu.',
    };
  }

  if (
    (m === 'GET' && (p === '/api/explorer' || p === '/api/explorer/diff')) ||
    (m === 'POST' && /^\/api\/servers\/[^/]+\/test$/.test(p)) ||
    (m === 'POST' && p === '/api/jobs') ||
    (m === 'PATCH' && /^\/api\/jobs\/[^/]+$/.test(p)) ||
    (m === 'POST' && p === '/api/schedules/retention')
  ) {
    if (role === 'ADMIN' || role === 'OPERATOR') {
      return { allowed: true };
    }
    return {
      allowed: false,
      error:
        'Tài khoản VIEWER chỉ có quyền xem (Read-Only), không có quyền thực hiện thao tác này.',
    };
  }

  // 5. Mặc định Fail-Closed: Chỉ ADMIN được phép (Users, Audit Logs, SSH Keys, Settings, Update/Rollback, Restore, CRUD Server/Volume/Schedule, Xóa Job)
  if (role === 'ADMIN') {
    return { allowed: true };
  }

  return {
    allowed: false,
    error: 'Thao tác này yêu cầu quyền Quản trị viên (ADMIN).',
  };
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

      const skipAuthAndRbacCheck =
        pathname.startsWith('/_next') ||
        pathname === '/favicon.ico' ||
        pathname === '/api/health' ||
        pathname === '/api/auth/login' ||
        pathname === '/api/auth/logout';

      if (!skipAuthAndRbacCheck) {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
        if (token) {
          const session = await verifySessionToken(token);
          const liveUser = session
            ? getUserAuthStateFromDb(session.userId, session.tokenVersion)
            : null;

          if (!session || !liveUser) {
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
          } else if (pathname.startsWith('/api/')) {
            const rbac = evaluateApiRbac(
              req.method || 'GET',
              pathname,
              liveUser.role
            );
            if (!rbac.allowed) {
              res.statusCode = 403;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              res.end(
                JSON.stringify({
                  error:
                    rbac.error ||
                    'Thao tác này yêu cầu quyền Quản trị viên (ADMIN).',
                })
              );
              return;
            }
          }
        } else if (pathname.startsWith('/api/')) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(
            JSON.stringify({
              error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn.',
            })
          );
          return;
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
      !getUserAuthStateFromDb(session.userId, session.tokenVersion)
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

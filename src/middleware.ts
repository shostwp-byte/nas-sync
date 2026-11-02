import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/jwt-edge';

const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/health'];
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function matchesExpectedHost(sourceUrl: string, rawExpectedHost: string): boolean {
  if (!rawExpectedHost) return false;
  try {
    const parsed = new URL(sourceUrl);
    const sourceHost = parsed.host.toLowerCase();
    const expected =
      parsed.protocol === 'https:'
        ? rawExpectedHost.replace(/:443$/, '')
        : parsed.protocol === 'http:'
        ? rawExpectedHost.replace(/:80$/, '')
        : rawExpectedHost;
    return Boolean(expected) && sourceHost === expected;
  } catch {
    return false;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Chống tấn công CSRF trên mọi API thay đổi trạng thái (POST / PUT / PATCH / DELETE)
  if (pathname.startsWith('/api/') && STATE_CHANGING_METHODS.has(req.method)) {
    const rawHostHeader =
      req.headers.get('x-forwarded-host') || req.headers.get('host') || '';
    const expectedHost = rawHostHeader.split(',')[0]?.trim().toLowerCase() || '';

    const origin = req.headers.get('origin');
    if (origin) {
      if (!matchesExpectedHost(origin, expectedHost)) {
        return NextResponse.json(
          {
            error:
              'Yêu cầu bị từ chối do sai lệch nguồn gửi (CSRF Origin mismatch).',
          },
          { status: 403 }
        );
      }
    } else {
      const referer = req.headers.get('referer');
      if (referer && !matchesExpectedHost(referer, expectedHost)) {
        return NextResponse.json(
          {
            error:
              'Yêu cầu bị từ chối do sai lệch nguồn gửi (CSRF Origin mismatch).',
          },
          { status: 403 }
        );
      }
    }
  }

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/socket.io') ||
    pathname === '/favicon.ico' ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Chưa đăng nhập hoặc phiên làm việc đã hết hạn.' },
        { status: 401 }
      );
    }
    const loginUrl = new URL('/login', req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};


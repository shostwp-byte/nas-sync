import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  getCurrentSession,
  sessionCookieOptions,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (session) {
      getDb()
        .prepare(
          'UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = ?'
        )
        .run(session.userId);
    }
  } catch {
    // Đảm bảo vẫn xóa cookie kể cả khi không đọc được phiên cũ
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', sessionCookieOptions(req, 0));
  return res;
}

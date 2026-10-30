import { NextRequest, NextResponse } from 'next/server';
import {
  getCurrentSession,
  hashPassword,
  verifyPassword,
} from '@/lib/auth';
import { getDb } from '@/lib/db';

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ user: session });
}

export async function PATCH(req: NextRequest) {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (newPassword.length < 6) {
    return NextResponse.json(
      { error: 'Mật khẩu mới phải có ít nhất 6 ký tự.' },
      { status: 400 }
    );
  }

  const db = getDb();
  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(session.userId);
  if (!user || !verifyPassword(currentPassword, String(user.password_hash))) {
    return NextResponse.json(
      { error: 'Mật khẩu hiện tại không đúng.' },
      { status: 400 }
    );
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
    hashPassword(newPassword),
    session.userId
  );

  return NextResponse.json({ ok: true, message: 'Đã cập nhật mật khẩu Admin.' });
}


import { NextRequest, NextResponse } from 'next/server';
import { safeErrorJson } from '@/lib/api-error';
import { recordAuditLog } from '@/lib/audit';
import { hashPassword, isValidUserRole, requireRole } from '@/lib/auth';
import { getDb } from '@/lib/db';
import type { UserRecord, UserRole } from '@/types';

const USERNAME_RE = /^[a-zA-Z0-9._@-]+$/;

export async function GET() {
  const guard = await requireRole(['ADMIN']);
  if (!guard.ok) return guard.response;

  const rows = getDb()
    .prepare(
      `SELECT id, username, role, totp_enabled, last_login_at, created_at
       FROM users
       ORDER BY id ASC`
    )
    .all();

  const users: UserRecord[] = rows.map((r) => ({
    id: Number(r.id),
    username: String(r.username),
    role: (isValidUserRole(r.role) ? r.role : 'VIEWER') as UserRole,
    totp_enabled: Number(r.totp_enabled || 0),
    last_login_at: r.last_login_at ? String(r.last_login_at) : null,
    created_at: String(r.created_at),
  }));

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireRole(['ADMIN']);
    if (!guard.ok) return guard.response;

    const body = await req.json();
    const username = String(body.username || '').trim();
    const password = typeof body.password === 'string' ? body.password : '';
    const rawRole = String(body.role || 'VIEWER')
      .trim()
      .toUpperCase();

    if (username.length < 3 || username.length > 32) {
      return NextResponse.json(
        { error: 'Tên đăng nhập phải dài từ 3 đến 32 ký tự.' },
        { status: 400 }
      );
    }

    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        {
          error:
            'Tên đăng nhập chỉ được chứa chữ cái không dấu, chữ số và các ký tự . _ @ - (không chứa khoảng trắng).',
        },
        { status: 400 }
      );
    }

    if (password.length < 8 || password.length > 256) {
      return NextResponse.json(
        { error: 'Mật khẩu phải có độ dài từ 8 đến 256 ký tự.' },
        { status: 400 }
      );
    }

    if (!isValidUserRole(rawRole)) {
      return NextResponse.json(
        { error: 'Vai trò không hợp lệ (chỉ chấp nhận ADMIN, OPERATOR, VIEWER).' },
        { status: 400 }
      );
    }

    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)')
      .get(username);
    if (existing) {
      return NextResponse.json(
        { error: `Tên đăng nhập "${username}" đã tồn tại trên hệ thống.` },
        { status: 400 }
      );
    }

    const res = db
      .prepare(
        `INSERT INTO users (username, password_hash, role)
         VALUES (?, ?, ?)`
      )
      .run(username, hashPassword(password), rawRole);

    const newId = Number(res.lastInsertRowid);

    recordAuditLog({
      session: guard.session,
      action: 'USER_CREATE',
      resourceType: 'USER',
      resourceId: String(newId),
      detail: `Tạo tài khoản "${username}" với vai trò ${rawRole}`,
      req,
    });

    return NextResponse.json({
      ok: true,
      userId: newId,
    });
  } catch (err) {
    return safeErrorJson(err, 'Không thể tạo tài khoản người dùng.', 500);
  }
}

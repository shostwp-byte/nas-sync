import { cookies } from 'next/headers';
import {
  SESSION_COOKIE_NAME,
  SessionPayload,
  signSessionToken,
  verifySessionToken,
} from './jwt-edge';
import { hashPassword, verifyPassword } from './password';

export {
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifySessionToken,
  hashPassword,
  verifyPassword,
  type SessionPayload,
};

export async function getCurrentSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

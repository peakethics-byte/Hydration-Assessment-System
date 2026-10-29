import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from './db';
import { sessionUser, type Role, type SessionUser } from './auth';

export const SESSION_COOKIE = 'wch2o_session';

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionUser(await getDb(), token);
}

/** Server-side gate for a page. Screens are a convenience; the database still enforces access. */
export async function requireUser(...roles: Role[]): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect('/login');
  if (roles.length && !u.roles.some((r) => roles.includes(r.role))) redirect('/');
  return u;
}

export function homeFor(u: SessionUser): string {
  const roles = u.roles.map((r) => r.role);
  if (roles.includes('program_admin')) return '/admin';
  if (roles.includes('athlete')) return '/athlete';
  return '/staff';
}

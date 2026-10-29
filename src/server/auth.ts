// Email + password sign-in (approved for the MVP). In staging this is replaced by Supabase Auth,
// which adds MFA for privileged roles; the session/role model below stays the same.
import type { Db, Tx } from './db';
import { audit } from './audit';
import { newToken, sha256, verifyPassword } from './crypto';

export type Role = 'athlete' | 'program_admin' | 'health_support' | 'coach' | 'inst_leader' | 'tech_admin';

export interface RoleAssignment {
  role: Role;
  tenantId: string | null;
  scopeType: string;
  scopeId: string | null;
  canExport: boolean;
}

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  roles: RoleAssignment[];
}

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 8;
const PRIVILEGED_IDLE_MINUTES = 30;
const PRIVILEGED: Role[] = ['program_admin', 'health_support', 'tech_admin'];

export const ROLE_LABELS: Record<Role, string> = {
  athlete: 'Athlete',
  program_admin: 'WeCanH2O Program Administrator',
  health_support: 'Athletic Trainer / Sports Medicine / Approved Health Support',
  coach: 'Coach / Team Leadership',
  inst_leader: 'Athletic Department / NIL / Institution Leadership',
  tech_admin: 'Technical System Administrator',
};

async function rolesOf(tx: Tx, userId: string): Promise<RoleAssignment[]> {
  const r = await tx.query<{ role: Role; tenant_id: string | null; scope_type: string; scope_id: string | null; can_export: boolean }>(
    `select role, tenant_id, scope_type, scope_id, can_export from role_assignment
     where user_id = $1 and valid_from <= now() and (valid_to is null or valid_to > now())`,
    [userId],
  );
  return r.rows.map((x) => ({ role: x.role, tenantId: x.tenant_id, scopeType: x.scope_type, scopeId: x.scope_id, canExport: x.can_export }));
}

export type LoginResult = { ok: true; sessionToken: string } | { ok: false; message: string };

export async function login(db: Db, email: string, password: string): Promise<LoginResult> {
  return db.system(async (tx) => {
    const u = (await tx.query<{ user_id: string; password_hash: string | null; status: string; failed_logins: number; locked_until: string | null }>(
      'select user_id, password_hash, status, failed_logins, locked_until from app_user where lower(email) = lower($1)', [email.trim()],
    )).rows[0];
    const generic = { ok: false as const, message: 'The email or password is not correct.' };
    if (!u || u.status !== 'Active') {
      await audit(tx, { action: 'sign_in_failed', recordType: 'app_user', newValue: { email: email.trim().toLowerCase() } });
      return generic;
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await audit(tx, { userId: u.user_id, action: 'sign_in_locked', recordType: 'app_user', recordId: u.user_id });
      return { ok: false, message: `Too many attempts. Try again after ${LOCK_MINUTES} minutes.` };
    }
    if (!verifyPassword(password, u.password_hash)) {
      const failed = u.failed_logins + 1;
      await tx.query(
        `update app_user set failed_logins = $2::int, locked_until = case when $2::int >= $3::int then now() + make_interval(mins => $4::int) end where user_id = $1`,
        [u.user_id, failed, MAX_FAILED, LOCK_MINUTES],
      );
      await audit(tx, { userId: u.user_id, action: 'sign_in_failed', recordType: 'app_user', recordId: u.user_id, newValue: { failed } });
      return generic;
    }
    await tx.query('update app_user set failed_logins = 0, locked_until = null where user_id = $1', [u.user_id]);
    const token = newToken();
    await tx.query(
      `insert into user_session (session_hash, user_id, expires_at) values ($1, $2, now() + make_interval(hours => $3))`,
      [sha256(token), u.user_id, SESSION_HOURS],
    );
    await audit(tx, { userId: u.user_id, action: 'sign_in', recordType: 'app_user', recordId: u.user_id });
    return { ok: true, sessionToken: token };
  });
}

export async function sessionUser(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  return db.system(async (tx) => {
    const s = (await tx.query<{ user_id: string; email: string; display_name: string; last_seen_at: string }>(
      `select s.user_id, u.email, u.display_name, s.last_seen_at from user_session s join app_user u using (user_id)
       where s.session_hash = $1 and s.ended_at is null and s.expires_at > now() and u.status = 'Active'`,
      [sha256(token)],
    )).rows[0];
    if (!s) return null;
    const roles = await rolesOf(tx, s.user_id);
    const privileged = roles.some((r) => PRIVILEGED.includes(r.role));
    if (privileged && Date.now() - new Date(s.last_seen_at).getTime() > PRIVILEGED_IDLE_MINUTES * 60_000) {
      await tx.query('update user_session set ended_at = now() where session_hash = $1', [sha256(token)]);
      return null;
    }
    await tx.query('update user_session set last_seen_at = now() where session_hash = $1', [sha256(token)]);
    return { userId: s.user_id, email: s.email, displayName: s.display_name, roles };
  });
}

export async function logout(db: Db, token: string | undefined) {
  if (!token) return;
  await db.system(async (tx) => {
    const r = await tx.query<{ user_id: string }>('update user_session set ended_at = now() where session_hash = $1 returning user_id', [sha256(token)]);
    if (r.rows[0]) await audit(tx, { userId: r.rows[0].user_id, action: 'sign_out', recordType: 'app_user', recordId: r.rows[0].user_id });
  });
}

export function hasRole(u: SessionUser, role: Role, tenantId?: string) {
  return u.roles.some((r) => r.role === role && (tenantId === undefined || r.tenantId === tenantId));
}

export function adminTenants(u: SessionUser): string[] {
  return u.roles.filter((r) => r.role === 'program_admin' && r.tenantId).map((r) => r.tenantId!);
}

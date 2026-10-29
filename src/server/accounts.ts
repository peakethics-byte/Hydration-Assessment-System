// Staff accounts (F2: the WeCanH2O Program Administrator adds staff and business roles) and
// individual users (request access -> WeCanH2O approves -> the athlete registration link).
import type { Db, Tx } from './db';
import type { Role } from './auth';
import { audit, sendEmail } from './audit';
import { hashPassword, newToken, passwordProblem, sha256 } from './crypto';
import { createUser } from './institution';
import { PermissionError, requireAdmin } from './roster';

const SETUP_DAYS = 7;
const LINK_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const STAFF_ROLES = ['program_admin', 'health_support', 'coach', 'inst_leader'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

function baseUrl() {
  return process.env.APP_BASE_URL ?? 'http://localhost:3100';
}

// ---------- Staff accounts ----------
export interface StaffInput {
  tenantId: string;
  name: string;
  email: string;
  role: StaffRole;
  /** Team for a coach (required) or a team-scoped athletic trainer; empty = whole institution. */
  teamId?: string;
  canExport?: boolean;
}

async function issueSetupLink(tx: Tx, userId: string, tenantId: string, adminUserId: string, name: string, email: string, roleLabel: string, institution: string) {
  const token = newToken();
  await tx.query(
    `insert into account_setup_token (token_hash, user_id, tenant_id, created_by, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [sha256(token), userId, tenantId, adminUserId, SETUP_DAYS],
  );
  const link = `${baseUrl()}/account/setup/${token}`;
  await sendEmail(tx, email, 'Your Structured Hydration Assessment account', [
    `Hello ${name},`,
    '',
    `WeCanH2O has given you ${roleLabel} access for ${institution}.`,
    `Use the link below to choose your password. The link works for ${SETUP_DAYS} days.`,
    '',
    link,
    '',
    'If you did not expect this email, you can ignore it.',
  ].join('\n'), link);
}

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  program_admin: 'WeCanH2O Program Administrator',
  health_support: 'Athletic Trainer / Health Support',
  coach: 'Coach / Team Leadership',
  inst_leader: 'Athletic Department / Institution Leadership',
};

export async function addStaff(db: Db, adminUserId: string, input: StaffInput) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name) throw new PermissionError('Please enter the person\'s name.');
  if (!EMAIL_RE.test(email)) throw new PermissionError('Please enter a valid email.');
  if (!STAFF_ROLES.includes(input.role)) throw new PermissionError('Please choose a role.');
  if (input.role === 'coach' && !input.teamId) throw new PermissionError('A coach must be linked to a team.');
  if ((input.role === 'program_admin' || input.role === 'inst_leader') && input.teamId) {
    throw new PermissionError('This role covers the whole institution; do not choose a team.');
  }
  if (input.canExport && input.role === 'coach') throw new PermissionError('Coaches cannot be given export permission.');

  return db.system(async (tx) => {
    await requireAdmin(tx, adminUserId, input.tenantId);
    const tenant = (await tx.query<{ display_name: string }>('select display_name from tenant where tenant_id = $1', [input.tenantId])).rows[0];
    if (input.teamId) {
      const ok = (await tx.query('select 1 from team where team_id = $1 and tenant_id = $2', [input.teamId, input.tenantId])).rows.length;
      if (!ok) throw new PermissionError('That team does not belong to this institution.');
    }
    const existing = (await tx.query<{ user_id: string; display_name: string; status: string }>(
      'select user_id, display_name, status from app_user where lower(email) = $1', [email])).rows[0];
    if (existing) {
      const athlete = (await tx.query('select 1 from participant where user_id = $1', [existing.user_id])).rows.length;
      if (athlete) throw new PermissionError('This email belongs to an athlete account. Use a different email for staff access.');
      const same = (await tx.query(
        `select 1 from role_assignment where user_id = $1 and tenant_id = $2 and role = $3
         and coalesce(scope_id::text, '') = coalesce($4, '') and (valid_to is null or valid_to > now())`,
        [existing.user_id, input.tenantId, input.role, input.teamId ?? null])).rows.length;
      if (same) throw new PermissionError('This person already has this role.');
    }
    const userId = existing?.user_id ?? await createUser(tx, email, name, null);
    if (!existing) await tx.query('update app_user set setup_pending = true where user_id = $1', [userId]);
    await tx.query(
      `insert into role_assignment (user_id, role, tenant_id, scope_type, scope_id, can_export) values ($1, $2, $3, $4, $5, $6)`,
      [userId, input.role, input.tenantId, input.teamId ? 'team' : 'tenant', input.teamId ?? null, Boolean(input.canExport)],
    );
    await audit(tx, { tenantId: input.tenantId, userId: adminUserId, action: 'role_assigned', recordType: 'role_assignment', recordId: userId,
      newValue: { email, role: input.role, teamId: input.teamId ?? null, canExport: Boolean(input.canExport), newAccount: !existing } });
    if (!existing) {
      await issueSetupLink(tx, userId, input.tenantId, adminUserId, name, email, STAFF_ROLE_LABELS[input.role], tenant.display_name);
    } else {
      await sendEmail(tx, email, 'New access in the Structured Hydration Assessment', [
        `Hello ${existing.display_name},`, '',
        `WeCanH2O has given you ${STAFF_ROLE_LABELS[input.role]} access for ${tenant.display_name}.`,
        'Sign in with your existing account to use it.',
      ].join('\n'));
    }
    return { userId, newAccount: !existing };
  });
}

/** Sends a new password-setup link to a staff member who has not set a password yet. */
export async function resendSetupLink(db: Db, adminUserId: string, userId: string, tenantId: string) {
  return db.system(async (tx) => {
    await requireAdmin(tx, adminUserId, tenantId);
    const u = (await tx.query<{ display_name: string; email: string; setup_pending: boolean }>(
      'select display_name, email, setup_pending from app_user where user_id = $1', [userId])).rows[0];
    const ra = (await tx.query<{ role: StaffRole }>(
      `select role from role_assignment where user_id = $1 and tenant_id = $2 and (valid_to is null or valid_to > now()) limit 1`,
      [userId, tenantId])).rows[0];
    if (!u || !ra) throw new PermissionError('User not found.');
    if (!u.setup_pending) throw new PermissionError('This person has already set a password.');
    const tenant = (await tx.query<{ display_name: string }>('select display_name from tenant where tenant_id = $1', [tenantId])).rows[0];
    await tx.query('update account_setup_token set expires_at = now() where user_id = $1 and used_at is null', [userId]);
    await issueSetupLink(tx, userId, tenantId, adminUserId, u.display_name, u.email, STAFF_ROLE_LABELS[ra.role], tenant.display_name);
    await audit(tx, { tenantId, userId: adminUserId, action: 'setup_link_resent', recordType: 'app_user', recordId: userId });
  });
}

/** Ends one staff role. The history stays; nothing is deleted. */
export async function endStaffRole(db: Db, adminUserId: string, roleAssignmentId: string) {
  return db.system(async (tx) => {
    const ra = (await tx.query<{ user_id: string; tenant_id: string; role: Role }>(
      'select user_id, tenant_id, role from role_assignment where role_assignment_id = $1 and (valid_to is null or valid_to > now())',
      [roleAssignmentId])).rows[0];
    if (!ra || !ra.tenant_id) throw new PermissionError('Role not found.');
    await requireAdmin(tx, adminUserId, ra.tenant_id);
    if (ra.role === 'athlete') throw new PermissionError('Athlete access is not ended here.');
    if (ra.user_id === adminUserId && ra.role === 'program_admin') throw new PermissionError('You cannot end your own administrator access.');
    await tx.query('update role_assignment set valid_to = now() where role_assignment_id = $1', [roleAssignmentId]);
    await audit(tx, { tenantId: ra.tenant_id, userId: adminUserId, action: 'role_ended', recordType: 'role_assignment', recordId: roleAssignmentId,
      oldValue: { userId: ra.user_id, role: ra.role } });
  });
}

export async function setupInfo(db: Db, token: string) {
  return db.system(async (tx) => {
    const r = (await tx.query<{ display_name: string; email: string; institution: string; used_at: string | null; expired: boolean }>(
      `select u.display_name, u.email, t.display_name as institution, s.used_at, s.expires_at <= now() as expired
       from account_setup_token s join app_user u using (user_id) join tenant t on t.tenant_id = s.tenant_id where s.token_hash = $1`,
      [sha256(token)])).rows[0];
    if (!r) return { ok: false as const, message: 'This link is not valid.' };
    if (r.used_at) return { ok: false as const, message: 'This link was already used. Please sign in.' };
    if (r.expired) return { ok: false as const, message: 'This link has expired. Please ask WeCanH2O to send a new one.' };
    return { ok: true as const, name: r.display_name, email: r.email, institution: r.institution };
  });
}

export async function completeSetup(db: Db, token: string, password: string) {
  const pw = passwordProblem(password);
  if (pw) return { ok: false as const, message: pw };
  return db.system(async (tx) => {
    const s = (await tx.query<{ token_hash: string; user_id: string; tenant_id: string; used_at: string | null; expired: boolean }>(
      'select token_hash, user_id, tenant_id, used_at, expires_at <= now() as expired from account_setup_token where token_hash = $1 for update',
      [sha256(token)])).rows[0];
    if (!s || s.used_at || s.expired) return { ok: false as const, message: 'This link is no longer valid.' };
    await tx.query('update app_user set password_hash = $2, setup_pending = false where user_id = $1', [s.user_id, hashPassword(password)]);
    await tx.query('update account_setup_token set used_at = now() where token_hash = $1', [s.token_hash]);
    await audit(tx, { tenantId: s.tenant_id, userId: s.user_id, action: 'account_setup_completed', recordType: 'app_user', recordId: s.user_id });
    return { ok: true as const };
  });
}

// ---------- Individual users ----------
async function personalTenant(tx: Tx) {
  const t = (await tx.query<{ tenant_id: string }>(
    `select tenant_id from tenant where tenant_kind = 'personal' and status = 'Active' order by created_at limit 1`)).rows[0];
  if (!t) throw new PermissionError('Individual access is not available yet.');
  return t.tenant_id;
}

/** A person who is not on a college team list asks for access. WeCanH2O reviews every request. */
export async function requestAccess(db: Db, input: { firstName: string; lastName: string; email: string }) {
  const first = input.firstName.trim();
  const last = input.lastName.trim();
  const email = input.email.trim().toLowerCase();
  if (!first || !last || !EMAIL_RE.test(email)) return { ok: false as const, message: 'Please enter your first name, last name and a valid email.' };
  return db.system(async (tx) => {
    const tenantId = await personalTenant(tx);
    if ((await tx.query('select 1 from app_user where lower(email) = $1', [email])).rows.length) {
      return { ok: false as const, message: 'This email already has an account. Please sign in instead.' };
    }
    const open = (await tx.query<{ status: string }>(
      `select status from access_request where email_normalized = $1 and status in ('Pending', 'Approved')`, [email])).rows[0];
    if (open?.status === 'Pending') return { ok: false as const, message: 'We already have a request from this email. WeCanH2O will email you after review.' };
    if (open?.status === 'Approved') return { ok: false as const, message: 'Your request was already approved. Please use the sign-up link in your email.' };
    const id = (await tx.query<{ request_id: string }>(
      'insert into access_request (tenant_id, first_name, last_name, email_normalized) values ($1, $2, $3, $4) returning request_id',
      [tenantId, first, last, email])).rows[0].request_id;
    await audit(tx, { tenantId, action: 'access_requested', recordType: 'access_request', recordId: id, newValue: { email } });
    const admins = (await tx.query<{ email: string }>(
      `select distinct u.email from role_assignment ra join app_user u using (user_id)
       where ra.tenant_id = $1 and ra.role = 'program_admin' and u.status = 'Active' and (ra.valid_to is null or ra.valid_to > now())`,
      [tenantId])).rows;
    for (const a of admins) {
      await sendEmail(tx, a.email, 'New individual access request',
        'A new request for individual access to the Structured Hydration Assessment is waiting for review.\n\nPlease sign in and open Requests.');
    }
    return { ok: true as const, message: 'Thank you. WeCanH2O will review your request and email you a sign-up link if it is approved.' };
  });
}

export async function listRequests(db: Db, adminUserId: string) {
  return db.asUser(adminUserId, (tx) => tx.query<{ request_id: string; first_name: string; last_name: string; email_normalized: string; status: string;
    requested_at: string; decided_at: string | null; decision_note: string | null; decided_by_name: string | null }>(
    `select r.request_id, r.first_name, r.last_name, r.email_normalized, r.status, r.requested_at, r.decided_at, r.decision_note,
            u.display_name as decided_by_name
     from access_request r left join app_user u on u.user_id = r.decided_by
     order by (r.status = 'Pending') desc, r.requested_at desc`)).then((r) => r.rows);
}

export async function decideRequest(db: Db, adminUserId: string, requestId: string, approve: boolean, note?: string) {
  return db.system(async (tx) => {
    const r = (await tx.query<{ tenant_id: string; first_name: string; email_normalized: string; status: string }>(
      'select tenant_id, first_name, email_normalized, status from access_request where request_id = $1 for update', [requestId])).rows[0];
    if (!r) throw new PermissionError('Request not found.');
    await requireAdmin(tx, adminUserId, r.tenant_id);
    if (r.status !== 'Pending') throw new PermissionError('This request was already decided.');
    const status = approve ? 'Approved' : 'Declined';
    await tx.query('update access_request set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where request_id = $1',
      [requestId, status, adminUserId, note?.trim() || null]);
    if (approve) {
      const token = newToken();
      await tx.query(
        `insert into signup_token (token_hash, tenant_id, access_request_id, kind, expires_at)
         values ($1, $2, $3, 'personal', now() + make_interval(days => $4))`,
        [sha256(token), r.tenant_id, requestId, LINK_DAYS]);
      const link = `${baseUrl()}/register/${token}`;
      await sendEmail(tx, r.email_normalized, 'Your access to the Structured Hydration Assessment', [
        `Hello ${r.first_name},`, '',
        'WeCanH2O has approved your request for individual access to the Structured Hydration Assessment.',
        `Use the link below to set your password and finish signing up. The link works for ${LINK_DAYS} days.`, '',
        link,
      ].join('\n'), link);
    } else {
      // DRAFT wording - for WeCanH2O to confirm.
      await sendEmail(tx, r.email_normalized, 'Your request for the Structured Hydration Assessment', [
        `Hello ${r.first_name},`, '',
        'Thank you for your interest. WeCanH2O is not able to approve your request for individual access at this time.',
      ].join('\n'));
    }
    await audit(tx, { tenantId: r.tenant_id, userId: adminUserId, action: approve ? 'access_approved' : 'access_declined',
      recordType: 'access_request', recordId: requestId, reason: note?.trim() || null });
  });
}

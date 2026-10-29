// Roster & athlete records (F3) and the two athlete sign-up ways. Both start from the team list
// the college sends: Way 1 website sign-up checked against the list; Way 2 emailed invitation.
import type { Db, Tx } from './db';
import { audit, sendEmail } from './audit';
import { hashPassword, identityHash, identityMatchHash, newToken, passwordProblem, sha256 } from './crypto';
import { createUser, nextAthleteCode } from './institution';

const LINK_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PermissionError extends Error {}

export async function requireAdmin(tx: Tx, userId: string, tenantId: string) {
  const ok = (await tx.query(
    `select 1 from role_assignment where user_id = $1 and tenant_id = $2 and role = 'program_admin'
     and valid_from <= now() and (valid_to is null or valid_to > now())`, [userId, tenantId],
  )).rows.length > 0;
  if (!ok) {
    await audit(tx, { tenantId, userId, action: 'denied', recordType: 'permission', reason: 'program_admin required' });
    throw new PermissionError('You do not have permission for this action.');
  }
}

function baseUrl() {
  return process.env.APP_BASE_URL ?? 'http://localhost:3100';
}

// ---------- Team list upload ----------
export interface RosterUploadResult { added: number; skipped: { line: number; reason: string }[] }

/** CSV columns: first_name, last_name, email, institution_athlete_id (optional). Header row optional. */
export async function uploadRoster(db: Db, adminUserId: string, teamId: string, csv: string): Promise<RosterUploadResult> {
  return db.asUser(adminUserId, async (tx) => {
    const team = (await tx.query<{ tenant_id: string }>('select tenant_id from team where team_id = $1', [teamId])).rows[0];
    if (!team) throw new PermissionError('Team not found.');
    const result: RosterUploadResult = { added: 0, skipped: [] };
    const lines = csv.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const cols = line.split(',').map((c) => c.trim());
      if (i === 0 && /first/i.test(cols[0]) && /email/i.test(cols[2] ?? '')) continue; // header
      const [first, last, email, instId] = cols;
      if (!first || !last || !email) { result.skipped.push({ line: i + 1, reason: 'Needs first name, last name and email' }); continue; }
      if (!EMAIL_RE.test(email)) { result.skipped.push({ line: i + 1, reason: `Email "${email}" is not valid` }); continue; }
      const r = await tx.query(
        `insert into roster_entry (tenant_id, team_id, first_name, last_name, email_normalized, institution_athlete_id, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict (team_id, email_normalized) do nothing returning roster_entry_id`,
        [team.tenant_id, teamId, first, last, email.toLowerCase(), instId || null, adminUserId],
      );
      if (r.rows.length) result.added++;
      else result.skipped.push({ line: i + 1, reason: `${email} is already on this team list` });
    }
    await audit(tx, { tenantId: team.tenant_id, userId: adminUserId, action: 'roster_upload', recordType: 'team', recordId: teamId, newValue: result });
    return result;
  });
}

async function issueLink(tx: Tx, entry: { roster_entry_id: string; tenant_id: string; email_normalized: string; first_name: string },
  kind: 'invitation' | 'website', institution: string, team: string) {
  const token = newToken();
  await tx.query(
    `insert into signup_token (token_hash, tenant_id, roster_entry_id, kind, expires_at) values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [sha256(token), entry.tenant_id, entry.roster_entry_id, kind, LINK_DAYS],
  );
  const link = `${baseUrl()}/register/${token}`;
  const subject = kind === 'invitation' ? 'Your invitation to the Structured Hydration Assessment' : 'Finish signing up for the Structured Hydration Assessment';
  const body = [
    `Hello ${entry.first_name},`,
    '',
    kind === 'invitation'
      ? `${institution} has invited you to take the Structured Hydration Assessment as a member of ${team}.`
      : `We found your name on the ${team} team list at ${institution}.`,
    'Use the link below to set your password and finish signing up. The link works for 14 days.',
    '',
    link,
    '',
    'If you did not expect this email, you can ignore it.',
  ].join('\n');
  await sendEmail(tx, entry.email_normalized, subject, body, link);
  return token;
}

// ---------- Way 2: invitation ----------
export async function sendInvitations(db: Db, adminUserId: string, teamId: string) {
  return db.system(async (tx) => {
    const team = (await tx.query<{ tenant_id: string; name: string; institution: string }>(
      'select t.tenant_id, t.name, tn.display_name as institution from team t join tenant tn using (tenant_id) where t.team_id = $1', [teamId],
    )).rows[0];
    if (!team) throw new PermissionError('Team not found.');
    await requireAdmin(tx, adminUserId, team.tenant_id);
    const entries = (await tx.query<{ roster_entry_id: string; tenant_id: string; email_normalized: string; first_name: string }>(
      `select roster_entry_id, tenant_id, email_normalized, first_name from roster_entry where team_id = $1 and status = 'Listed'`, [teamId],
    )).rows;
    for (const e of entries) {
      await issueLink(tx, e, 'invitation', team.institution, team.name);
      await tx.query(`update roster_entry set status = 'Invited' where roster_entry_id = $1`, [e.roster_entry_id]);
    }
    await audit(tx, { tenantId: team.tenant_id, userId: adminUserId, action: 'invitations_sent', recordType: 'team', recordId: teamId, newValue: { count: entries.length } });
    return { sent: entries.length };
  });
}

// ---------- Way 1: website sign-up ----------
export type WebsiteSignupResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export async function websiteSignup(db: Db, input: { firstName: string; lastName: string; email: string }): Promise<WebsiteSignupResult> {
  const email = input.email.trim().toLowerCase();
  if (!input.firstName.trim() || !input.lastName.trim() || !EMAIL_RE.test(email)) {
    return { ok: false, message: 'Please enter your first name, last name and a valid email.' };
  }
  return db.system(async (tx) => {
    const entries = (await tx.query<{ roster_entry_id: string; tenant_id: string; email_normalized: string; first_name: string; status: string; team: string; institution: string }>(
      `select r.roster_entry_id, r.tenant_id, r.email_normalized, r.first_name, r.status, t.name as team, tn.display_name as institution
       from roster_entry r join team t using (team_id) join tenant tn on tn.tenant_id = r.tenant_id
       where r.email_normalized = $1 and r.status <> 'Withdrawn' and tn.status = 'Active' order by r.uploaded_at`, [email],
    )).rows;
    if (entries.length === 0) {
      await audit(tx, { action: 'website_signup_no_match', recordType: 'roster_entry', newValue: { email } });
      return { ok: false, message: 'We could not find this email on a team list. Please contact your coach so they can check the team list.' };
    }
    const open = entries.filter((e) => e.status !== 'Registered');
    if (open.length === 0) return { ok: false, message: 'This email is already registered. Please sign in instead.' };
    // One link per institution; registration places the athlete on every listed team there.
    const seen = new Set<string>();
    for (const e of open) {
      if (seen.has(e.tenant_id)) continue;
      seen.add(e.tenant_id);
      await issueLink(tx, e, 'website', e.institution, e.team);
      await tx.query(`update roster_entry set status = 'Link Sent' where roster_entry_id = $1 and status in ('Listed', 'Invited')`, [e.roster_entry_id]);
      await audit(tx, { tenantId: e.tenant_id, action: 'website_signup_matched', recordType: 'roster_entry', recordId: e.roster_entry_id,
        newValue: { nameEntered: `${input.firstName.trim()} ${input.lastName.trim()}` } });
    }
    return { ok: true, message: 'Thank you. We found you on your team list and sent you an email with a sign-up link.' };
  });
}

// ---------- Registration (both ways end here) ----------
export async function registrationInfo(db: Db, token: string) {
  return db.system(async (tx) => {
    // The link comes from a team list entry (college athletes) or an approved individual request.
    const r = (await tx.query<{ first_name: string; last_name: string; email_normalized: string; team: string | null; institution: string; used_at: string | null; expired: boolean }>(
      `select coalesce(r.first_name, a.first_name) as first_name, coalesce(r.last_name, a.last_name) as last_name,
              coalesce(r.email_normalized, a.email_normalized) as email_normalized, t.name as team, tn.display_name as institution,
              s.used_at, s.expires_at <= now() as expired
       from signup_token s join tenant tn on tn.tenant_id = s.tenant_id
         left join roster_entry r on r.roster_entry_id = s.roster_entry_id left join team t on t.team_id = r.team_id
         left join access_request a on a.request_id = s.access_request_id
       where s.token_hash = $1`, [sha256(token)],
    )).rows[0];
    if (!r) return { ok: false as const, message: 'This link is not valid.' };
    if (r.used_at) return { ok: false as const, message: 'This link was already used. Please sign in.' };
    if (r.expired) return { ok: false as const, message: 'This link has expired. Please sign up again or contact your coach.' };
    return { ok: true as const, firstName: r.first_name, lastName: r.last_name, email: r.email_normalized, team: r.team, institution: r.institution };
  });
}

export interface RegistrationInput { password: string; dateOfBirth: string; mothersMaidenName: string }

export async function completeRegistration(db: Db, token: string, input: RegistrationInput) {
  const pw = passwordProblem(input.password);
  if (pw) return { ok: false as const, message: pw };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth) || Number.isNaN(Date.parse(input.dateOfBirth))) {
    return { ok: false as const, message: 'Please enter your date of birth.' };
  }
  if (!input.mothersMaidenName.trim()) return { ok: false as const, message: "Please enter your mother's maiden name." };

  return db.system(async (tx) => {
    const s = (await tx.query<{ token_hash: string; tenant_id: string; roster_entry_id: string | null; access_request_id: string | null; used_at: string | null; expired: boolean }>(
      'select token_hash, tenant_id, roster_entry_id, access_request_id, used_at, expires_at <= now() as expired from signup_token where token_hash = $1 for update',
      [sha256(token)],
    )).rows[0];
    if (!s || s.used_at || s.expired) return { ok: false as const, message: 'This link is no longer valid.' };
    const entry = s.roster_entry_id
      ? (await tx.query<{ first_name: string; last_name: string; email_normalized: string; institution_athlete_id: string | null }>(
          'select first_name, last_name, email_normalized, institution_athlete_id from roster_entry where roster_entry_id = $1', [s.roster_entry_id],
        )).rows[0]
      : (await tx.query<{ first_name: string; last_name: string; email_normalized: string; institution_athlete_id: string | null }>(
          `select first_name, last_name, email_normalized, null as institution_athlete_id from access_request where request_id = $1 and status = 'Approved'`,
          [s.access_request_id],
        )).rows[0];
    if (!entry) return { ok: false as const, message: 'This link is no longer valid.' };
    const exists = (await tx.query('select 1 from app_user where lower(email) = $1', [entry.email_normalized])).rows.length > 0;
    if (exists) return { ok: false as const, message: 'An account with this email already exists. Please sign in.' };

    const userId = await createUser(tx, entry.email_normalized, `${entry.first_name} ${entry.last_name}`, null);
    await tx.query('update app_user set password_hash = $2 where user_id = $1', [userId, hashPassword(input.password)]);
    const athleteCode = await nextAthleteCode(tx);
    const participantId = (await tx.query<{ participant_id: string }>(
      `insert into participant (tenant_id, population_code, athlete_code, user_id) values ($1, 'A', $2, $3) returning participant_id`,
      [s.tenant_id, athleteCode, userId],
    )).rows[0].participant_id;
    const matchHash = identityMatchHash(entry.first_name, entry.last_name, input.dateOfBirth, input.mothersMaidenName);
    await tx.query(
      `insert into athlete_profile (participant_id, tenant_id, first_name, last_name, email, institution_athlete_id, date_of_birth, mothers_maiden_name_hash, identity_match_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [participantId, s.tenant_id, entry.first_name, entry.last_name, entry.email_normalized, entry.institution_athlete_id,
        input.dateOfBirth, identityHash(input.mothersMaidenName), matchHash],
    );
    await tx.query(
      `insert into role_assignment (user_id, role, tenant_id, scope_type, scope_id) values ($1, 'athlete', $2, 'athlete', $3)`,
      [userId, s.tenant_id, participantId],
    );
    // Place the athlete on every team list in this institution that carries the email.
    const teams = (await tx.query<{ roster_entry_id: string; team_id: string }>(
      `select roster_entry_id, team_id from roster_entry where tenant_id = $1 and email_normalized = $2 and status <> 'Withdrawn'`,
      [s.tenant_id, entry.email_normalized],
    )).rows;
    for (const t of teams) {
      await tx.query('insert into athlete_team_affiliation (tenant_id, participant_id, team_id) values ($1, $2, $3)', [s.tenant_id, participantId, t.team_id]);
      await tx.query(`update roster_entry set status = 'Registered', participant_id = $2 where roster_entry_id = $1`, [t.roster_entry_id, participantId]);
    }
    if (s.access_request_id) {
      await tx.query(`update access_request set status = 'Registered', participant_id = $2 where request_id = $1`, [s.access_request_id, participantId]);
    }
    await tx.query('update signup_token set used_at = now() where token_hash = $1', [s.token_hash]);

    // Potential duplicates go to a person for review; never merged automatically (TST-LFC-005).
    const candidates = (await tx.query<{ participant_id: string; reason: string }>(
      `select p.participant_id,
              case when ap.identity_match_hash = $3 then 'Same name, date of birth and mother''s maiden name'
                   else 'Same name and date of birth' end as reason
       from athlete_profile ap join participant p using (participant_id)
       where ap.tenant_id = $1 and p.participant_id <> $2 and p.status = 'Active'
         and (ap.identity_match_hash = $3
              or (lower(ap.first_name) = lower($4) and lower(ap.last_name) = lower($5) and ap.date_of_birth = $6))`,
      [s.tenant_id, participantId, matchHash, entry.first_name, entry.last_name, input.dateOfBirth],
    )).rows;
    for (const c of candidates) {
      await tx.query('insert into duplicate_review (tenant_id, participant_id, candidate_participant_id, reason) values ($1, $2, $3, $4)',
        [s.tenant_id, participantId, c.participant_id, c.reason]);
    }
    await audit(tx, { tenantId: s.tenant_id, userId, action: 'athlete_registered', recordType: 'participant', recordId: participantId,
      newValue: { athleteCode, teams: teams.length, individual: Boolean(s.access_request_id), potentialDuplicates: candidates.length } });
    return { ok: true as const, athleteCode, participantId, userId };
  });
}

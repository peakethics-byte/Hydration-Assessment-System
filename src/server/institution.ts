// Institution & Program Setup (F1) and user/role management (F2) used by seeding and admin screens.
import type { Tx } from './db';
import type { Role } from './auth';
import { audit } from './audit';
import { hashPassword } from './crypto';

const iso = (d: Date) => d.toISOString().slice(0, 10);
function addMonths(isoDate: string, months: number) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function dayBefore(d: Date) {
  return iso(new Date(d.getTime() - 86_400_000));
}

/** Program Year and four quarterly periods + Annual from the Program Start Date (TST-DAT-001). */
export function programPeriods(startDate: string) {
  const quarters = [0, 1, 2, 3].map((q) => ({
    type: `Q${q + 1}` as const,
    start: iso(addMonths(startDate, q * 3)),
    end: dayBefore(addMonths(startDate, (q + 1) * 3)),
  }));
  return { quarters, annual: { type: 'Annual' as const, start: startDate, end: dayBefore(addMonths(startDate, 12)) } };
}

export async function createTenant(tx: Tx, name: string, population: 'A' | 'B' = 'A', userId: string | null = null) {
  const t = (await tx.query<{ tenant_id: string }>(
    `insert into tenant (population_code, display_name, status) values ($1, $2, 'Active') returning tenant_id`, [population, name],
  )).rows[0];
  await audit(tx, { tenantId: t.tenant_id, userId, action: 'create', recordType: 'tenant', recordId: t.tenant_id, newValue: { name, population } });
  return t.tenant_id;
}

export async function createProgramYear(tx: Tx, tenantId: string, startDate: string, userId: string | null = null) {
  const p = programPeriods(startDate);
  const py = (await tx.query<{ program_year_id: string }>(
    `insert into program_year (tenant_id, program_start_date, program_end_date) values ($1, $2, $3) returning program_year_id`,
    [tenantId, startDate, p.annual.end],
  )).rows[0].program_year_id;
  for (const period of [...p.quarters, p.annual]) {
    await tx.query(
      `insert into reporting_period (tenant_id, program_year_id, period_type, start_date, end_date, original_start, original_end)
       values ($1, $2, $3, $4, $5, $4, $5)`,
      [tenantId, py, period.type, period.start, period.end],
    );
  }
  await audit(tx, { tenantId, userId, action: 'create', recordType: 'program_year', recordId: py, newValue: { startDate } });
  return py;
}

export async function createProgram(tx: Tx, tenantId: string, name: string) {
  return (await tx.query<{ program_id: string }>(
    'insert into athletic_program (tenant_id, name) values ($1, $2) returning program_id', [tenantId, name],
  )).rows[0].program_id;
}

export async function createTeam(tx: Tx, tenantId: string, programId: string, name: string, sport: string,
  heatSafetyProcedures: 'exist' | 'none' | 'unknown' = 'exist') {
  return (await tx.query<{ team_id: string }>(
    'insert into team (tenant_id, program_id, name, sport, heat_safety_procedures) values ($1, $2, $3, $4, $5) returning team_id',
    [tenantId, programId, name, sport, heatSafetyProcedures],
  )).rows[0].team_id;
}

export async function createUser(tx: Tx, email: string, displayName: string, password: string | null) {
  return (await tx.query<{ user_id: string }>(
    'insert into app_user (email, display_name, password_hash) values ($1, $2, $3) returning user_id',
    [email.trim().toLowerCase(), displayName, password ? hashPassword(password) : null],
  )).rows[0].user_id;
}

export async function assignRole(tx: Tx, userId: string, role: Role, tenantId: string | null,
  scope: { type: 'platform' | 'tenant' | 'program' | 'team' | 'athlete'; id?: string } = { type: 'tenant' },
  opts: { canExport?: boolean; byUserId?: string | null } = {}) {
  await tx.query(
    `insert into role_assignment (user_id, role, tenant_id, scope_type, scope_id, can_export) values ($1, $2, $3, $4, $5, $6)`,
    [userId, role, tenantId, scope.type, scope.id ?? null, opts.canExport ?? false],
  );
  await audit(tx, { tenantId, userId: opts.byUserId ?? null, action: 'role_assigned', recordType: 'role_assignment', recordId: userId,
    newValue: { role, scope } });
}

export async function nextAthleteCode(tx: Tx) {
  const n = (await tx.query<{ n: string }>("select nextval('athlete_code_seq')::text as n")).rows[0].n;
  return `ATH-${n.padStart(6, '0')}`;
}

export async function currentProgramYear(tx: Tx, tenantId: string) {
  const r = (await tx.query<{ program_year_id: string }>(
    `select program_year_id from program_year where tenant_id = $1 and status = 'Active'
     and program_start_date <= current_date and program_end_date >= current_date order by program_start_date desc limit 1`,
    [tenantId],
  )).rows[0];
  if (!r) throw new Error('No active Program Year for this institution');
  return r.program_year_id;
}

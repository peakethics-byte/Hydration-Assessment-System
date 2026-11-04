import type { Tx, Db } from '../db';
import { audit } from '../audit';
import { PermissionError } from '../roster';

// ---------------------------------------------------------------- scope
export interface ReportScope {
  tenantId: string;
  role: 'admin' | 'leader' | 'coach';
  teamIds: string[] | null; // null = whole institution
  canExport: boolean;
}

/** The reporting scope of a user for one institution, or a PermissionError (PRV-205, TST-PRV-002). */
export async function reportScope(tx: Tx, userId: string, tenantId: string): Promise<ReportScope> {
  const roles = (await tx.query<{ role: string; scope_type: string; scope_id: string | null; can_export: boolean }>(
    `select role, scope_type, scope_id, can_export from role_assignment
     where user_id = $1 and tenant_id = $2 and role in ('program_admin', 'inst_leader', 'coach')
       and valid_from <= now() and (valid_to is null or valid_to > now())`, [userId, tenantId])).rows;
  const canExport = roles.some((r) => r.can_export);
  if (roles.some((r) => r.role === 'program_admin')) return { tenantId, role: 'admin', teamIds: null, canExport };
  if (roles.some((r) => r.role === 'inst_leader')) return { tenantId, role: 'leader', teamIds: null, canExport };
  const coach = roles.filter((r) => r.role === 'coach');
  if (coach.length) {
    if (coach.some((r) => r.scope_type === 'tenant')) return { tenantId, role: 'coach', teamIds: null, canExport };
    const teamIds = coach.filter((r) => r.scope_type === 'team' && r.scope_id).map((r) => r.scope_id!);
    if (coach.some((r) => r.scope_type === 'program')) {
      const progs = coach.filter((r) => r.scope_type === 'program').map((r) => r.scope_id);
      teamIds.push(...(await tx.query<{ team_id: string }>('select team_id from team where program_id = any($1)', [progs])).rows.map((x) => x.team_id));
    }
    return { tenantId, role: 'coach', teamIds, canExport };
  }
  await audit(tx, { tenantId, userId, action: 'denied', recordType: 'report', reason: 'no reporting role for this institution' });
  throw new PermissionError('You do not have access to reports for this institution.');
}

/** Institutions the user can report on (for the institution picker). */
export async function reportTenants(db: Db, userId: string) {
  return (await db.system((tx) => tx.query<{ tenant_id: string; display_name: string; population_code: string }>(
    `select distinct t.tenant_id, t.display_name, t.population_code from role_assignment ra join tenant t using (tenant_id)
     where ra.user_id = $1 and ra.role in ('program_admin', 'inst_leader', 'coach') and t.tenant_kind <> 'personal'
       and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now()) order by t.display_name`, [userId]))).rows;
}

/** Reporting hierarchy labels per population module (Module B is schema-only in this contract). */
export function hierarchyLabels(population: string) {
  return population === 'B'
    ? { institution: 'Organization', program: 'Site', team: 'Work group', athlete: 'Participant' }
    : { institution: 'Institution', program: 'Athletic program', team: 'Team', athlete: 'Athlete' };
}

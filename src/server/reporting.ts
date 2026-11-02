// Team / institution aggregation, the institution dashboard, formal quarterly and annual reports,
// reporting periods and exports (contract Week 6; Document #5).
//
// Access model: coaches and institution leaders cannot read individual records (row-level security).
// The reporting service therefore checks the signed-in user's reporting scope first, then aggregates on
// the server, applies small-cell suppression, and returns only population-level figures.
import type { Db, Tx } from './db';
import { audit } from './audit';
import { PermissionError, requireAdmin } from './roster';
import { OUTCOME_UNKNOWN, SCORED } from './reassessment';
import { programPeriods } from './institution';
import type { ScoringContent } from '../methodology/types';
import {
  complementTooSmall, describeChange, metric, hidden, summarize, summarizeMatched, suppressTeams,
  type CohortRow, type GroupSummary, type MatchedRow, type MatchedSummary, type Metric,
} from '../engine/aggregate';

export const DEFAULT_THRESHOLD = 5;
export const QUARTERLY = 'Quarterly Hydration Gap Report';
export const ANNUAL = 'Annual Hydration Intelligence Impact Report';

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

// ---------------------------------------------------------------- settings, periods
export async function threshold(tx: Tx, tenantId: string): Promise<number> {
  const r = (await tx.query<{ suppression_threshold: number }>('select suppression_threshold from report_setting where tenant_id = $1', [tenantId])).rows[0];
  return r?.suppression_threshold ?? DEFAULT_THRESHOLD;
}

export interface Period { period_id: string; program_year_id: string; period_type: string; start_date: string; end_date: string; original_start: string; original_end: string }

export async function periodsFor(tx: Tx, tenantId: string) {
  const years = (await tx.query<{ program_year_id: string; program_start_date: string; program_end_date: string; status: string; renewed_from_id: string | null }>(
    `select program_year_id, program_start_date::text, program_end_date::text, status, renewed_from_id from program_year
     where tenant_id = $1 order by program_start_date desc`, [tenantId])).rows;
  const periods = (await tx.query<Period>(
    `select period_id, program_year_id, period_type, start_date::text, end_date::text, original_start::text, original_end::text
     from reporting_period where tenant_id = $1 order by start_date, period_type`, [tenantId])).rows;
  return { years, periods };
}

/** The period containing today (quarters first), else the latest one. */
export function currentPeriod(periods: Period[], today = new Date().toISOString().slice(0, 10)) {
  const q = periods.filter((p) => p.period_type !== 'Annual');
  return q.find((p) => p.start_date <= today && today <= p.end_date) ?? q[q.length - 1] ?? periods[0];
}

/** Authorized reporting-date change, keeping the original and revised values (DAT-007, AUD-201). */
export async function adjustPeriod(db: Db, userId: string, input: { periodId: string; start: string; end: string; reason: string }) {
  return db.system(async (tx) => {
    const p = (await tx.query<Period & { tenant_id: string }>(
      'select period_id, tenant_id, program_year_id, period_type, start_date::text, end_date::text, original_start::text, original_end::text from reporting_period where period_id = $1',
      [input.periodId])).rows[0];
    if (!p) throw new Error('Reporting period not found.');
    await requireAdmin(tx, userId, p.tenant_id);
    if (!input.reason.trim()) return { ok: false as const, message: 'A reason is required for a reporting-date change.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.end) || input.end < input.start) {
      return { ok: false as const, message: 'Enter valid dates; the end date cannot be before the start date.' };
    }
    const released = (await tx.query(`select 1 from formal_report where period_id = $1 and status in ('Approved', 'Released')`, [p.period_id])).rows.length;
    if (released) return { ok: false as const, message: 'This period already has an approved or released report. Issue a correction instead.' };
    await tx.query(
      `insert into reporting_period_change (period_id, tenant_id, old_start, old_end, new_start, new_end, reason, changed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`, [p.period_id, p.tenant_id, p.start_date, p.end_date, input.start, input.end, input.reason.trim(), userId]);
    await tx.query('update reporting_period set start_date = $2, end_date = $3, adjusted_by = $4, adjusted_reason = $5 where period_id = $1',
      [p.period_id, input.start, input.end, userId, input.reason.trim()]);
    await audit(tx, { tenantId: p.tenant_id, userId, action: 'adjust', recordType: 'reporting_period', recordId: p.period_id,
      oldValue: { start: p.start_date, end: p.end_date }, newValue: { start: input.start, end: input.end }, reason: input.reason.trim() });
    return { ok: true as const };
  });
}

export async function periodChanges(db: Db, userId: string, tenantId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<{ period_type: string; old_start: string; old_end: string; new_start: string; new_end: string; reason: string; changed_at: string; display_name: string }>(
    `select rp.period_type, c.old_start::text, c.old_end::text, c.new_start::text, c.new_end::text, c.reason, c.changed_at::text, u.display_name
     from reporting_period_change c join reporting_period rp using (period_id) join app_user u on u.user_id = c.changed_by
     where c.tenant_id = $1 order by c.changed_at desc`, [tenantId])).rows);
}

/** Renewal creates the next Program Year without touching earlier periods or reports (DAT-008). */
export async function renewProgramYear(db: Db, userId: string, tenantId: string) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, tenantId);
    const last = (await tx.query<{ program_year_id: string; program_end_date: string }>(
      'select program_year_id, program_end_date::text from program_year where tenant_id = $1 order by program_start_date desc limit 1', [tenantId])).rows[0];
    if (!last) throw new Error('No Program Year to renew.');
    const start = new Date(`${last.program_end_date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    const startDate = start.toISOString().slice(0, 10);
    const p = programPeriods(startDate);
    const py = (await tx.query<{ program_year_id: string }>(
      `insert into program_year (tenant_id, program_start_date, program_end_date, renewed_from_id, status) values ($1, $2, $3, $4, 'Setup') returning program_year_id`,
      [tenantId, startDate, p.annual.end, last.program_year_id])).rows[0].program_year_id;
    for (const period of [...p.quarters, p.annual]) {
      await tx.query(`insert into reporting_period (tenant_id, program_year_id, period_type, start_date, end_date, original_start, original_end)
        values ($1, $2, $3, $4, $5, $4, $5)`, [tenantId, py, period.type, period.start, period.end]);
    }
    await audit(tx, { tenantId, userId, action: 'renew', recordType: 'program_year', recordId: py, newValue: { startDate, renewedFrom: last.program_year_id } });
    return py;
  });
}

export async function setThreshold(db: Db, userId: string, tenantId: string, value: number) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, tenantId);
    if (!Number.isInteger(value) || value < 1 || value > 100) return { ok: false as const, message: 'Enter a whole number from 1 to 100.' };
    const old = await threshold(tx, tenantId);
    await tx.query(`insert into report_setting (tenant_id, suppression_threshold, updated_by, updated_at) values ($1, $2, $3, now())
      on conflict (tenant_id) do update set suppression_threshold = $2, updated_by = $3, updated_at = now()`, [tenantId, value, userId]);
    await audit(tx, { tenantId, userId, action: 'update', recordType: 'report_setting', recordId: tenantId, oldValue: { threshold: old }, newValue: { threshold: value } });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------- data loading
export interface Filters { teamId?: string; type?: 'all' | 'baseline' | 'reassessment'; version?: string }

async function loadScoring(tx: Tx, scrId: string | null): Promise<ScoringContent> {
  const id = scrId ?? (await tx.query<{ rule_version_id: string }>(`select rule_version_id from rule_version where family = 'SCR' and status = 'Active' limit 1`)).rows[0]?.rule_version_id;
  return (await tx.query<{ content: ScoringContent }>('select content from rule_version where rule_version_id = $1', [id])).rows[0].content;
}

/** Valid scored assessments submitted in the period, with their stored results. */
async function loadCohort(tx: Tx, tenantId: string, start: string, end: string, teamIds: string[] | null): Promise<(CohortRow & { scrVersion: string; hgaVersion: string })[]> {
  const inst = (await tx.query<{ instance_id: string; participant_id: string; team_id: string | null; is_baseline: boolean; submitted_at: string;
    asm_version_id: string; scr_version_id: string; hga_version_id: string; hgi_internal: string | null }>(
    `select i.instance_id, i.participant_id, i.team_id, i.is_baseline, i.submitted_at::text, i.asm_version_id, i.scr_version_id, i.hga_version_id,
            h.hgi_internal::text
     from assessment_instance i join hgi_result h using (instance_id)
     where i.tenant_id = $1 and i.status = any($2) and h.status = 'Calculated'
       and i.submitted_at::date between $3::date and $4::date
       and ($5::uuid[] is null or i.team_id = any($5::uuid[]))`,
    [tenantId, SCORED, start, end, teamIds])).rows;
  if (!inst.length) return [];
  const ids = inst.map((i) => i.instance_id);
  const cats = (await tx.query<{ instance_id: string; category: string; percent_internal: string | null; status: string }>(
    'select instance_id, category, percent_internal::text, status from category_score where instance_id = any($1)', [ids])).rows;
  const finds = (await tx.query<{ instance_id: string; rule_id: string; title: string; category: string | null; source_class: string | null;
    priority_class: number | null; is_safety: boolean; finding_type: string }>(
    `select instance_id, rule_id, title, category, source_class, priority_class, is_safety, finding_type from hga_finding
     where instance_id = any($1) and superseded_at is null`, [ids])).rows;
  return inst.map((i) => ({
    participantId: i.participant_id,
    instanceId: i.instance_id,
    teamId: i.team_id,
    isBaseline: i.is_baseline,
    submittedAt: i.submitted_at,
    asmVersion: i.asm_version_id,
    scrVersion: i.scr_version_id,
    hgaVersion: i.hga_version_id,
    hgiInternal: i.hgi_internal,
    categories: Object.fromEntries(cats.filter((c) => c.instance_id === i.instance_id).map((c) => [c.category, { percent: c.percent_internal, status: c.status }])),
    findings: finds.filter((f) => f.instance_id === i.instance_id).map((f) => ({
      ruleId: f.rule_id, title: f.title, category: f.category, sourceClass: f.source_class, priorityClass: f.priority_class,
      isSafety: f.is_safety, isStrength: f.finding_type === 'strength',
    })),
  }));
}

/** Matched Cohort: athletes whose reassessment in the period has a comparable baseline (REP-019, REP-025). */
async function loadMatched(tx: Tx, tenantId: string, start: string, end: string, teamIds: string[] | null): Promise<MatchedRow[]> {
  const rows = (await tx.query<{ change_analysis_id: string; participant_id: string; hgi_baseline: string; hgi_current: string; hgi_change: string; submitted_at: string }>(
    `select ca.change_analysis_id, ca.participant_id, ca.hgi_baseline::text, ca.hgi_current::text, ca.hgi_change::text, i.submitted_at::text
     from change_analysis ca join assessment_instance i on i.instance_id = ca.current_instance_id
     where ca.tenant_id = $1 and ca.superseded_at is null and ca.comparison_status = 'Comparable' and ca.hgi_change is not null
       and i.status = any($2) and i.submitted_at::date between $3::date and $4::date
       and ($5::uuid[] is null or i.team_id = any($5::uuid[]))
     order by i.submitted_at`, [tenantId, SCORED, start, end, teamIds])).rows;
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(r.participant_id, r); // latest reassessment per athlete (REP-006)
  const keep = [...latest.values()];
  if (!keep.length) return [];
  const fc = (await tx.query<{ change_analysis_id: string; rule_id: string; title: string; state: string; is_safety: boolean; is_contextual: boolean; source_class: string | null }>(
    `select change_analysis_id, rule_id, title, state, is_safety, is_contextual, source_class from finding_change where change_analysis_id = any($1)`,
    [keep.map((k) => k.change_analysis_id)])).rows;
  return keep.map((k) => ({
    participantId: k.participant_id, hgiBaseline: k.hgi_baseline, hgiCurrent: k.hgi_current, hgiChange: k.hgi_change,
    findingStates: fc.filter((f) => f.change_analysis_id === k.change_analysis_id).map((f) => ({
      ruleId: f.rule_id, title: f.title, state: f.state, isSafety: f.is_safety, isContextual: f.is_contextual, sourceClass: f.source_class })),
  }));
}

async function teamsOf(tx: Tx, tenantId: string, teamIds: string[] | null) {
  return (await tx.query<{ team_id: string; name: string; program: string; heat_safety_procedures: string }>(
    `select t.team_id, t.name, p.name as program, t.heat_safety_procedures from team t join athletic_program p using (program_id)
     where t.tenant_id = $1 and ($2::uuid[] is null or t.team_id = any($2::uuid[])) order by p.name, t.name`, [tenantId, teamIds])).rows;
}

/** Athletes on the team lists sent by the college by the end of the period ("number eligible where available"). */
async function eligibleCount(tx: Tx, tenantId: string, end: string, teamIds: string[] | null) {
  return (await tx.query<{ n: number }>(
    `select count(distinct coalesce(participant_id::text, email_normalized))::int as n from roster_entry
     where tenant_id = $1 and status <> 'Withdrawn' and uploaded_at::date <= $2::date and ($3::uuid[] is null or team_id = any($3::uuid[]))`,
    [tenantId, end, teamIds])).rows[0].n;
}

async function interventions(tx: Tx, tenantId: string, start: string, end: string, teamIds: string[] | null) {
  const r = (await tx.query<{ delivered: number; completed: number; athletes: number; released: number }>(
    `select count(*)::int as delivered,
            count(*) filter (where a.status = 'Completed / Implemented')::int as completed,
            count(distinct a.participant_id)::int as athletes,
            (select count(*)::int from assessment_instance x where x.tenant_id = $1 and x.released_at::date between $2::date and $3::date
               and ($4::uuid[] is null or x.team_id = any($4::uuid[]))) as released
     from action_item a join recommendation r using (rec_id) join assessment_instance i on i.instance_id = r.instance_id
     where a.tenant_id = $1 and a.superseded_at is null and a.assigned_at::date between $2::date and $3::date
       and ($4::uuid[] is null or i.team_id = any($4::uuid[]))`, [tenantId, start, end, teamIds])).rows[0];
  return { resultsReleased: r.released, itemsDelivered: r.delivered, athletesWithItems: r.athletes, itemsCompleted: metric(r.completed, r.delivered) };
}

/** Reassessment windows whose target end falls in the period; missed windows stay "Outcome Unknown" (REP-021). */
async function reassessmentWindows(tx: Tx, tenantId: string, start: string, end: string, teamIds: string[] | null) {
  const rows = (await tx.query<{ outcome: string; n: number }>(
    `select s.outcome, count(*)::int as n from reassessment_schedule s
     where s.tenant_id = $1 and s.target_end between $2::date and $3::date and s.outcome <> 'Cancelled'
       and ($4::uuid[] is null or exists (select 1 from athlete_team_affiliation a where a.participant_id = s.participant_id
             and a.team_id = any($4::uuid[]) and a.effective_start <= s.target_end and (a.effective_end is null or a.effective_end >= s.target_end)))
     group by s.outcome`, [tenantId, start, end, teamIds])).rows;
  const get = (o: string) => rows.find((r) => r.outcome === o)?.n ?? 0;
  const due = rows.reduce((a, r) => a + r.n, 0);
  return { due, completed: metric(get('Completed'), due), outcomeUnknown: metric(get(OUTCOME_UNKNOWN), due), stillOpen: metric(get('Scheduled'), due) };
}

// ---------------------------------------------------------------- dashboard / report data
export interface TeamRow { teamId: string; name: string; assessed: number; suppressed: boolean; hgiMean: string | null; safety: Metric & { present: boolean }; topGap: string | null }

export interface ReportData {
  tenant: { id: string; name: string; population: string };
  labels: ReturnType<typeof hierarchyLabels>;
  period: { id: string; type: string; start: string; end: string; programYearStart: string; programYearEnd: string };
  generatedAt: string;
  threshold: number;
  thresholdStatus: string;
  scope: { role: string; teams: string[] | null };
  filters: Filters;
  participation: { teams: string[]; eligible: number; assessed: number; baseline: number; reassessed: number; completion: Metric; versions: string[] };
  summary: GroupSummary;
  matched: MatchedSummary;
  changeText: string;
  fullPopulation: { assessed: number; hgiMean: string | null };
  interventions: Awaited<ReturnType<typeof interventions>>;
  reassessment: Awaited<ReturnType<typeof reassessmentWindows>>;
  trend: { period: string; start: string; end: string; assessed: number; hgiMean: string | null; suppressed: boolean }[];
  teams: TeamRow[];
  procedures: { exist: number; none: number; unknown: number };
  next: { reportDate: string | null; reportPeriod: string | null; reassessmentStart: string | null; reassessmentEnd: string | null };
  priorities: { kind: 'Safety / support' | 'Institutional / environmental' | 'Athlete'; title: string; detail: string }[];
  ruleVersions: string[];
  notes: string[];
}

const withhold = (s: GroupSummary): GroupSummary => ({
  ...s, suppressed: true, hgiMean: null, hgiMedian: null, hgiN: 0, bands: [], categories: [], gaps: [], strengths: [], institutional: [],
  safety: { ...hidden(), present: s.safety.present },
});

async function buildData(tx: Tx, scope: ReportScope, period: Period, filters: Filters): Promise<ReportData> {
  const tenant = (await tx.query<{ display_name: string; population_code: string }>('select display_name, population_code from tenant where tenant_id = $1', [scope.tenantId])).rows[0];
  const k = await threshold(tx, scope.tenantId);
  const setting = (await tx.query<{ threshold_status: string }>('select threshold_status from report_setting where tenant_id = $1', [scope.tenantId])).rows[0];
  const py = (await tx.query<{ program_start_date: string; program_end_date: string }>(
    'select program_start_date::text, program_end_date::text from program_year where program_year_id = $1', [period.program_year_id])).rows[0];

  // Team filter must stay inside the user's scope.
  let teamIds = scope.teamIds;
  if (filters.teamId) {
    if (teamIds && !teamIds.includes(filters.teamId)) throw new PermissionError('That team is outside your reporting scope.');
    teamIds = [filters.teamId];
  }
  const scopeAll = await loadCohort(tx, scope.tenantId, period.start_date, period.end_date, scope.teamIds);
  const typeOk = (r: CohortRow) => !filters.type || filters.type === 'all' || (filters.type === 'baseline' ? r.isBaseline : !r.isBaseline);
  const versionOk = (r: CohortRow) => !filters.version || r.asmVersion === filters.version;
  const inTeam = (r: CohortRow) => !teamIds || (r.teamId != null && teamIds.includes(r.teamId));
  const cohort = scopeAll.filter((r) => inTeam(r) && typeOk(r) && versionOk(r));
  const scoring = await loadScoring(tx, cohort[0]?.scrVersion ?? scopeAll[0]?.scrVersion ?? null);

  let summary = summarize(cohort, scoring, k);
  // A filtered view next to the unfiltered one must not reveal a group below the threshold (PRV-203).
  const whole = new Set(scopeAll.map((r) => r.participantId)).size;
  const filtered = Boolean(filters.teamId || (filters.type && filters.type !== 'all') || filters.version);
  if (filtered && !summary.suppressed && complementTooSmall(whole, summary.assessed, k)) {
    summary = withhold(summary);
  }

  const matchedRows = (await loadMatched(tx, scope.tenantId, period.start_date, period.end_date, teamIds))
    .filter((m) => !filters.type || filters.type !== 'baseline'); // a baseline-only view has no change
  const matched = summarizeMatched(matchedRows, k);
  const teams = await teamsOf(tx, scope.tenantId, scope.teamIds);

  // Team comparison, only where privacy permits (REP-013).
  const teamRows = suppressTeams(teams.map((t): TeamRow => {
    const s = summarize(scopeAll.filter((r) => r.teamId === t.team_id && typeOk(r) && versionOk(r)), scoring, k);
    return { teamId: t.team_id, name: t.name, assessed: s.assessed, suppressed: s.suppressed && s.assessed > 0, hgiMean: s.hgiMean, safety: s.safety,
      topGap: s.gaps.find((g) => !g.isSafety)?.title ?? null };
  }), k, (t) => ({ ...t, suppressed: true, hgiMean: null, topGap: null, safety: { ...hidden(), present: t.safety.present } }));

  // Quarterly trend across the Program Year (each quarter its own cohort).
  const { periods } = await periodsFor(tx, scope.tenantId);
  const trend = [];
  for (const q of periods.filter((p) => p.program_year_id === period.program_year_id && p.period_type !== 'Annual')) {
    const rows = (await loadCohort(tx, scope.tenantId, q.start_date, q.end_date, teamIds)).filter((r) => typeOk(r) && versionOk(r));
    const s = summarize(rows, scoring, k);
    trend.push({ period: q.period_type, start: q.start_date, end: q.end_date, assessed: s.assessed, hgiMean: s.hgiMean, suppressed: s.suppressed && s.assessed > 0 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const nextPeriod = periods.filter((p) => p.period_type !== 'Annual' && p.end_date >= today).sort((a, b) => a.end_date.localeCompare(b.end_date))[0];
  const nextWindow = (await tx.query<{ target_start: string; target_end: string }>(
    `select min(target_start)::text as target_start, min(target_end)::text as target_end from reassessment_schedule
     where tenant_id = $1 and outcome = 'Scheduled' and target_end >= current_date`, [scope.tenantId])).rows[0];

  const ids = [...new Set(cohort.map((r) => r.participantId))];
  const latest = new Map<string, CohortRow>();
  for (const r of cohort) if (!latest.has(r.participantId) || r.submittedAt > latest.get(r.participantId)!.submittedAt) latest.set(r.participantId, r);
  const eligible = await eligibleCount(tx, scope.tenantId, period.end_date, teamIds);
  const procs = { exist: 0, none: 0, unknown: 0 } as Record<string, number>;
  for (const t of teams.filter((t) => !teamIds || teamIds.includes(t.team_id))) procs[t.heat_safety_procedures] = (procs[t.heat_safety_procedures] ?? 0) + 1;

  const data: ReportData = {
    tenant: { id: scope.tenantId, name: tenant.display_name, population: tenant.population_code },
    labels: hierarchyLabels(tenant.population_code),
    period: { id: period.period_id, type: period.period_type, start: period.start_date, end: period.end_date, programYearStart: py.program_start_date, programYearEnd: py.program_end_date },
    generatedAt: new Date().toISOString(),
    threshold: k,
    thresholdStatus: setting?.threshold_status ?? 'DRAFT - pending privacy/legal/institutional review',
    scope: { role: scope.role, teams: scope.teamIds ? teams.map((t) => t.name) : null },
    filters,
    participation: {
      teams: teams.filter((t) => !teamIds || teamIds.includes(t.team_id)).map((t) => t.name),
      eligible,
      assessed: ids.length,
      baseline: [...latest.values()].filter((r) => r.isBaseline).length,
      reassessed: [...latest.values()].filter((r) => !r.isBaseline).length,
      completion: metric(ids.length, eligible),
      versions: [...new Set(cohort.map((r) => r.asmVersion))].sort(),
    },
    summary,
    matched,
    changeText: describeChange(matched),
    fullPopulation: { assessed: summary.assessed, hgiMean: summary.hgiMean },
    interventions: await interventions(tx, scope.tenantId, period.start_date, period.end_date, teamIds),
    reassessment: await reassessmentWindows(tx, scope.tenantId, period.start_date, period.end_date, teamIds),
    trend,
    teams: teamRows,
    procedures: { exist: procs.exist ?? 0, none: procs.none ?? 0, unknown: procs.unknown ?? 0 },
    next: { reportDate: nextPeriod?.end_date ?? null, reportPeriod: nextPeriod?.period_type ?? null,
      reassessmentStart: nextWindow?.target_start ?? null, reassessmentEnd: nextWindow?.target_end ?? null },
    priorities: [],
    ruleVersions: [...new Set(cohort.flatMap((r) => [r.asmVersion, r.scrVersion, r.hgaVersion]))].sort(),
    notes: [
      'One assessment per athlete is counted in each figure: the latest valid assessment in the period.',
      'Team figures use the team the athlete was on when the assessment was taken.',
      'Category 7 (Hair Care, Physical Activity & Hydration Access) is contextual and is never part of the HGI.',
      'The overall HGI band labels are not applied to individual categories.',
      `Groups with fewer than ${k} assessed athletes are not shown (privacy threshold, ${setting?.threshold_status ?? 'DRAFT'}).`,
    ],
  };
  data.priorities = priorities(data);
  return data;
}

/** Rules-based priority opportunities (report Section 8). Safety is never hidden by a favourable HGI (REP-031). */
export function priorities(d: ReportData): ReportData['priorities'] {
  const out: ReportData['priorities'] = [];
  if (d.summary.safety.present) {
    out.push({ kind: 'Safety / support', title: 'Safety / support follow-up',
      detail: d.summary.safety.suppressed ? `Present (fewer than ${d.threshold} athletes). Individual details stay with authorized health-support staff.`
        : `${d.summary.safety.n} of ${d.summary.safety.d} athletes (${d.summary.safety.pct}%). Individual details stay with authorized health-support staff.` });
  }
  for (const g of d.summary.institutional.filter((x) => !x.isSafety).slice(0, 2)) {
    out.push({ kind: 'Institutional / environmental', title: g.title, detail: `${g.athletes.n} of ${g.athletes.d} athletes (${g.athletes.pct}%)` });
  }
  if (d.procedures.none > 0) {
    out.push({ kind: 'Institutional / environmental', title: 'Team hydration and heat-safety procedures', detail: `${d.procedures.none} team(s) recorded with no procedures in place.` });
  }
  const used = new Set(out.map((o) => o.title));
  for (const g of d.summary.gaps.filter((x) => !x.isSafety && !used.has(x.title) && !d.summary.institutional.some((i) => i.ruleId === x.ruleId)).slice(0, 3)) {
    out.push({ kind: 'Athlete', title: g.title, detail: `${g.athletes.n} of ${g.athletes.d} athletes (${g.athletes.pct}%)` });
  }
  return out;
}

export async function dashboard(db: Db, userId: string, tenantId: string, input: { periodId?: string } & Filters = {}) {
  return db.system(async (tx) => {
    const scope = await reportScope(tx, userId, tenantId);
    const { periods, years } = await periodsFor(tx, tenantId);
    const period = periods.find((p) => p.period_id === input.periodId) ?? currentPeriod(periods);
    if (!period) throw new Error('This institution has no reporting periods yet.');
    const data = await buildData(tx, scope, period, { teamId: input.teamId || undefined, type: input.type, version: input.version || undefined });
    const teams = await teamsOf(tx, tenantId, scope.teamIds);
    return { data, periods, years, teams, scope };
  });
}

// ---------------------------------------------------------------- annual extras
export interface AnnualExtra {
  baseline: GroupSummary;
  yearEnd: MatchedSummary;
  yearEndText: string;
  gapStates: { state: string; patterns: { title: string; athletes: Metric }[] }[];
  outcomes: {
    athlete: { label: string; value: string }[];
    environment: { label: string; value: string }[];
    practices: { label: string; value: string }[];
    engagement: { label: string; value: string }[];
  };
}

async function annualExtra(tx: Tx, scope: ReportScope, period: Period, data: ReportData): Promise<AnnualExtra> {
  const k = data.threshold;
  const rows = await loadCohort(tx, scope.tenantId, period.start_date, period.end_date, scope.teamIds);
  const scoring = await loadScoring(tx, rows[0]?.scrVersion ?? null);
  const baseline = summarize(rows.filter((r) => r.isBaseline), scoring, k);
  const matchedRows = await loadMatched(tx, scope.tenantId, period.start_date, period.end_date, scope.teamIds);
  const yearEnd = summarizeMatched(matchedRows, k);
  const gapStates = yearEnd.suppressed || yearEnd.n === 0 ? [] : ['Persistent', 'Resolved', 'Worsened', 'New'].map((state) => {
    const counts = new Map<string, number>();
    for (const m of matchedRows) for (const f of m.findingStates) if (f.state === state && !f.isContextual) counts.set(f.title, (counts.get(f.title) ?? 0) + 1);
    return { state, patterns: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, n]) => ({ title, athletes: metric(n, yearEnd.n) })) };
  });
  const c2 = (s: GroupSummary) => s.categories.find((c) => c.code === 'C2')?.meanPct ?? null;
  const fmt = (m: Metric) => (m.suppressed ? 'withheld (privacy)' : `${m.n} of ${m.d} (${m.pct ?? '0.0'}%)`);
  const instBaseline = baseline.institutional.length;
  return {
    baseline,
    yearEnd,
    yearEndText: describeChange(yearEnd),
    gapStates,
    outcomes: {
      athlete: [
        { label: 'Matched Cohort (baseline to year-end)', value: yearEnd.suppressed ? 'withheld (privacy)' : `${yearEnd.n} athletes` },
        { label: 'Average HGI, baseline to year-end', value: yearEnd.meanChange == null ? 'not available' : `${yearEnd.baselineMean} to ${yearEnd.currentMean}` },
        { label: 'Athletes with a higher HGI', value: fmt(yearEnd.higher) },
      ],
      environment: [
        { label: 'Average Category 2 (Water Access & Environmental Barriers), baseline', value: c2(baseline) == null ? 'not available' : `${c2(baseline)}%` },
        { label: 'Average Category 2, full year', value: c2(data.summary) == null ? 'not available' : `${c2(data.summary)}%` },
        { label: 'Institutional / environmental patterns at baseline', value: baseline.suppressed ? 'withheld (privacy)' : String(instBaseline) },
      ],
      practices: [
        { label: 'Teams with hydration / heat-safety procedures recorded', value: `${data.procedures.exist} of ${data.procedures.exist + data.procedures.none + data.procedures.unknown}` },
        { label: 'Teams recorded with no procedures', value: String(data.procedures.none) },
      ],
      engagement: [
        { label: 'Athletes assessed in the Program Year', value: String(data.participation.assessed) },
        { label: 'Assessment completion (assessed / eligible)', value: fmt(data.participation.completion) },
        { label: 'Reassessment windows completed', value: fmt(data.reassessment.completed) },
        { label: 'Hydration Action Items completed', value: fmt(data.interventions.itemsCompleted) },
      ],
    },
  };
}

// ---------------------------------------------------------------- formal reports
export interface FormalReport {
  report_id: string; tenant_id: string; program_year_id: string; period_id: string; report_type: string; report_number: string; version: number;
  status: string; content: { data: ReportData; annual?: AnnualExtra }; narrative: Record<string, string>; rule_versions: string[];
  suppression_threshold: number; generated_at: string; generated_by_name: string | null; submitted_at: string | null; review_note: string | null;
  approved_at: string | null; approved_by_name: string | null; released_at: string | null; supersedes_id: string | null; superseded_at: string | null;
  correction_reason: string | null;
}

/** Narrative written by WeCanH2O (never generated): what each report type needs before review. */
export const NARRATIVE_FIELDS: Record<string, { key: string; label: string; required: boolean; help: string }[]> = {
  [QUARTERLY]: [
    { key: 'priorityNotes', label: 'Section 8 - Priority Opportunities: reviewer notes', required: false, help: 'Optional comments on the rules-based priorities.' },
    { key: 'nextQuarterActions', label: 'Section 9 - Recommended Next-Quarter Actions', required: true, help: 'Approved practical priorities for next quarter. Required before review.' },
  ],
  [ANNUAL]: [
    { key: 'executiveSummary', label: 'Executive Summary', required: true, help: 'Describe observed patterns; do not claim the program caused them.' },
    { key: 'institutionalActions', label: 'Institutional Actions / Program Practice Developments', required: false, help: 'Actions the institution took this year.' },
    { key: 'nextYear', label: 'Next-Year Recommendations and Priorities', required: true, help: 'Required before review.' },
  ],
};

const reportSelect = `select r.report_id, r.tenant_id, r.program_year_id, r.period_id, r.report_type, r.report_number, r.version, r.status, r.content, r.narrative,
  r.rule_versions, r.suppression_threshold, r.generated_at::text, g.display_name as generated_by_name, r.submitted_at::text, r.review_note,
  r.approved_at::text, a.display_name as approved_by_name, r.released_at::text, r.supersedes_id, r.superseded_at::text, r.correction_reason
  from formal_report r left join app_user g on g.user_id = r.generated_by left join app_user a on a.user_id = r.approved_by`;

async function buildReportContent(tx: Tx, scope: ReportScope, period: Period) {
  const data = await buildData(tx, { ...scope, teamIds: null }, period, {});
  const type = period.period_type === 'Annual' ? ANNUAL : QUARTERLY;
  return { type, content: type === ANNUAL ? { data, annual: await annualExtra(tx, { ...scope, teamIds: null }, period, data) } : { data } };
}

async function adminReport(tx: Tx, userId: string, reportId: string) {
  const r = (await tx.query<FormalReport>(`${reportSelect} where r.report_id = $1`, [reportId])).rows[0];
  if (!r) throw new Error('Report not found.');
  await requireAdmin(tx, userId, r.tenant_id);
  return r;
}

/** Generates a Draft from stored data (REP-001, TST-REP-001). */
export async function generateReport(db: Db, userId: string, input: { tenantId: string; periodId: string }) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, input.tenantId);
    const scope = await reportScope(tx, userId, input.tenantId);
    const period = (await periodsFor(tx, input.tenantId)).periods.find((p) => p.period_id === input.periodId);
    if (!period) throw new Error('Reporting period not found.');
    const open = (await tx.query<{ report_id: string }>(
      `select report_id from formal_report where period_id = $1 and status in ('Draft', 'Under Review', 'Revision Required', 'Approved')`, [period.period_id])).rows[0];
    if (open) return { ok: false as const, message: 'A report for this period is already in progress. Open it instead.', reportId: open.report_id };
    const released = (await tx.query(`select 1 from formal_report where period_id = $1 and status = 'Released'`, [period.period_id])).rows.length;
    if (released) return { ok: false as const, message: 'This period already has a released report. Issue a correction from that report instead.' };
    const { type, content } = await buildReportContent(tx, scope, period);
    const code = (await tx.query<{ display_name: string }>('select display_name from tenant where tenant_id = $1', [input.tenantId])).rows[0].display_name
      .replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase();
    const reportNumber = `${code}-${period.start_date.slice(0, 4)}-${period.period_type}`;
    const k = content.data.threshold;
    const id = (await tx.query<{ report_id: string }>(
      `insert into formal_report (tenant_id, program_year_id, period_id, report_type, report_number, version, content, rule_versions, suppression_threshold, generated_by)
       values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9) returning report_id`,
      [input.tenantId, period.program_year_id, period.period_id, type, reportNumber, JSON.stringify(content), content.data.ruleVersions, k, userId])).rows[0].report_id;
    await audit(tx, { tenantId: input.tenantId, userId, action: 'generate', recordType: 'formal_report', recordId: id, newValue: { reportNumber, version: 1, type } });
    return { ok: true as const, reportId: id };
  });
}

/** Refreshes the figures of a report that is still being prepared. */
export async function regenerateReport(db: Db, userId: string, reportId: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!['Draft', 'Revision Required'].includes(r.status)) return { ok: false as const, message: `A report that is ${r.status} cannot be regenerated.` };
    const period = (await periodsFor(tx, r.tenant_id)).periods.find((p) => p.period_id === r.period_id)!;
    const { content } = await buildReportContent(tx, await reportScope(tx, userId, r.tenant_id), period);
    await tx.query('update formal_report set content = $2, rule_versions = $3, suppression_threshold = $4, generated_at = now(), generated_by = $5 where report_id = $1',
      [reportId, JSON.stringify(content), content.data.ruleVersions, content.data.threshold, userId]);
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'regenerate', recordType: 'formal_report', recordId: reportId });
    return { ok: true as const };
  });
}

export async function saveNarrative(db: Db, userId: string, reportId: string, narrative: Record<string, string>) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!['Draft', 'Revision Required', 'Under Review'].includes(r.status)) return { ok: false as const, message: `A report that is ${r.status} is locked.` };
    const allowed = NARRATIVE_FIELDS[r.report_type].map((f) => f.key);
    const clean = Object.fromEntries(allowed.map((k) => [k, String(narrative[k] ?? '').trim().slice(0, 5000)]));
    await tx.query('update formal_report set narrative = $2 where report_id = $1', [reportId, JSON.stringify(clean)]);
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'edit_narrative', recordType: 'formal_report', recordId: reportId });
    return { ok: true as const };
  });
}

type Step = 'submit' | 'revise' | 'approve' | 'release';
const FROM: Record<Step, string[]> = { submit: ['Draft', 'Revision Required'], revise: ['Under Review'], approve: ['Under Review'], release: ['Approved'] };
const TO: Record<Step, string> = { submit: 'Under Review', revise: 'Revision Required', approve: 'Approved', release: 'Released' };

/** Draft -> Under Review -> (Revision Required) -> Approved -> Released (LFC-201, REP-033). */
export async function reportStep(db: Db, userId: string, reportId: string, step: Step, note?: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!FROM[step].includes(r.status)) return { ok: false as const, message: `This report is ${r.status}; that step is not available.` };
    if (step === 'submit') {
      const missing = NARRATIVE_FIELDS[r.report_type].filter((f) => f.required && !(r.narrative[f.key] ?? '').trim()).map((f) => f.label);
      if (missing.length) return { ok: false as const, message: `Complete before review: ${missing.join('; ')}.` };
    }
    if (step === 'revise' && !note?.trim()) return { ok: false as const, message: 'Explain what needs to change.' };
    const sets = {
      submit: 'submitted_at = now()',
      revise: 'review_note = $2',
      approve: 'approved_by = $2, approved_at = now()',
      release: 'released_by = $2, released_at = now()',
    }[step];
    await tx.query(`update formal_report set status = '${TO[step]}', ${sets} where report_id = $1`,
      step === 'revise' ? [reportId, note!.trim()] : step === 'submit' ? [reportId] : [reportId, userId]);
    if (step === 'release' && r.supersedes_id) {
      await tx.query(`update formal_report set status = 'Superseded', superseded_at = now() where report_id = $1`, [r.supersedes_id]);
      await audit(tx, { tenantId: r.tenant_id, userId, action: 'supersede', recordType: 'formal_report', recordId: r.supersedes_id, newValue: { supersededBy: reportId } });
    }
    await audit(tx, { tenantId: r.tenant_id, userId, action: step, recordType: 'formal_report', recordId: reportId,
      oldValue: { status: r.status }, newValue: { status: TO[step] }, reason: note?.trim() || null });
    return { ok: true as const };
  });
}

/** A released report is corrected by a new version; the original stays as it was (REP-034, TST-REP-011). */
export async function correctReport(db: Db, userId: string, reportId: string, reason: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (r.status !== 'Released') return { ok: false as const, message: 'Only a released report can be corrected.' };
    if (!reason.trim()) return { ok: false as const, message: 'A reason for the correction is required.' };
    const pending = (await tx.query(`select 1 from formal_report where supersedes_id = $1 and status <> 'Superseded'`, [reportId])).rows.length;
    if (pending) return { ok: false as const, message: 'A correction for this report is already in progress.' };
    const period = (await periodsFor(tx, r.tenant_id)).periods.find((p) => p.period_id === r.period_id)!;
    const { content } = await buildReportContent(tx, await reportScope(tx, userId, r.tenant_id), period);
    const version = (await tx.query<{ v: number }>('select max(version)::int as v from formal_report where report_number = $1', [r.report_number])).rows[0].v + 1;
    const id = (await tx.query<{ report_id: string }>(
      `insert into formal_report (tenant_id, program_year_id, period_id, report_type, report_number, version, content, narrative, rule_versions,
         suppression_threshold, generated_by, supersedes_id, correction_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning report_id`,
      [r.tenant_id, r.program_year_id, r.period_id, r.report_type, r.report_number, version, JSON.stringify(content), JSON.stringify(r.narrative),
        content.data.ruleVersions, content.data.threshold, userId, reportId, reason.trim()])).rows[0].report_id;
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'correct', recordType: 'formal_report', recordId: id,
      newValue: { reportNumber: r.report_number, version, supersedes: reportId }, reason: reason.trim() });
    return { ok: true as const, reportId: id };
  });
}

export async function listReports(db: Db, userId: string, tenantId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<FormalReport>(
    `${reportSelect} where r.tenant_id = $1 order by r.generated_at desc`, [tenantId])).rows);
}

/** Admin: any status. Institution leader: released reports of their institution only (row-level security). */
export async function getReport(db: Db, userId: string, reportId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<FormalReport>(`${reportSelect} where r.report_id = $1`, [reportId])).rows[0] ?? null);
}

// ---------------------------------------------------------------- exports
/** Logs an authorized export with user, scope, time, format and context (AUD-203, TST-AUD-001). */
export async function recordExport(db: Db, userId: string, input: { tenantId: string; format: 'PDF' | 'CSV'; context: Record<string, unknown> }) {
  return db.system(async (tx) => {
    const scope = await reportScope(tx, userId, input.tenantId);
    if (!scope.canExport) {
      await audit(tx, { tenantId: input.tenantId, userId, action: 'denied', recordType: 'export', reason: 'export right required', newValue: input.context });
      throw new PermissionError('Export is a separate right. Ask WeCanH2O to allow export for your account.');
    }
    await audit(tx, { tenantId: input.tenantId, userId, action: 'export', recordType: 'report_export',
      newValue: { format: input.format, scope: scope.teamIds ? { teams: scope.teamIds } : 'institution', ...input.context } });
    return scope;
  });
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mCells = (m: Metric) => (m.suppressed ? ['suppressed', '', '', ''] : [m.n, m.d, m.pct ?? '', '']);

/** Structured export of the aggregate figures, with the same suppression as the screen (PRV-203, REP-037). */
export function reportCsv(d: ReportData): string {
  const rows: unknown[][] = [
    ['institution', d.tenant.name], ['period', `${d.period.type} ${d.period.start} to ${d.period.end}`],
    ['program_year', `${d.period.programYearStart} to ${d.period.programYearEnd}`], ['generated_at', d.generatedAt],
    ['suppression_threshold', d.threshold], ['filters', JSON.stringify(d.filters)], [],
    ['section', 'measure', 'numerator', 'denominator', 'percent', 'value'],
    ['participation', 'eligible', '', '', '', d.participation.eligible],
    ['participation', 'assessed', '', '', '', d.participation.assessed],
    ['participation', 'baseline', '', '', '', d.participation.baseline],
    ['participation', 'reassessed', '', '', '', d.participation.reassessed],
    ['participation', 'completion', ...mCells(d.participation.completion)],
  ];
  const s = d.summary;
  if (s.suppressed) rows.push(['hgi', 'all health figures', 'suppressed', '', '', '']);
  else {
    rows.push(['hgi', 'mean', '', '', '', s.hgiMean], ['hgi', 'median', '', '', '', s.hgiMedian]);
    for (const b of s.bands) rows.push(['hgi_band', b.band, ...mCells(b.athletes)]);
    for (const c of s.categories) rows.push(['category', `${c.code} ${c.name}`, '', c.n, '', c.contextual ? 'contextual - not part of HGI' : c.meanPct]);
    for (const g of s.gaps) rows.push(['gap', g.title, ...mCells(g.athletes)]);
    for (const g of s.strengths) rows.push(['strength', g.title, ...mCells(g.athletes)]);
    for (const g of s.institutional) rows.push(['institutional', g.title, ...mCells(g.athletes)]);
    rows.push(['safety_support', 'athletes with an indicator', ...(s.safety.suppressed ? [s.safety.present ? 'present' : 'suppressed', '', '', ''] : mCells(s.safety))]);
  }
  const m = d.matched;
  rows.push(['matched_cohort', 'athletes', '', '', '', m.suppressed ? 'suppressed' : m.n]);
  if (!m.suppressed && m.n) {
    rows.push(['matched_cohort', 'mean HGI baseline', '', '', '', m.baselineMean], ['matched_cohort', 'mean HGI current', '', '', '', m.currentMean],
      ['matched_cohort', 'mean change', '', '', '', m.meanChange], ['matched_cohort', 'HGI higher', ...mCells(m.higher)],
      ['matched_cohort', 'HGI same', ...mCells(m.same)], ['matched_cohort', 'HGI lower', ...mCells(m.lower)]);
    for (const st of m.states) rows.push(['matched_cohort_gaps', st.state, ...mCells(st.athletes)]);
  }
  rows.push(['reassessment', 'windows due', '', '', '', d.reassessment.due], ['reassessment', 'completed', ...mCells(d.reassessment.completed)],
    ['reassessment', 'Outcome Unknown', ...mCells(d.reassessment.outcomeUnknown)], ['reassessment', 'still open', ...mCells(d.reassessment.stillOpen)],
    ['interventions', 'results released', '', '', '', d.interventions.resultsReleased], ['interventions', 'action items delivered', '', '', '', d.interventions.itemsDelivered],
    ['interventions', 'action items completed', ...mCells(d.interventions.itemsCompleted)]);
  for (const t of d.teams) rows.push(['team', t.name, '', '', '', t.suppressed ? 'suppressed' : `assessed ${t.assessed}; mean HGI ${t.hgiMean ?? '-'}`]);
  for (const t of d.trend) rows.push(['trend', `${t.period} ${t.start} to ${t.end}`, '', '', '', t.suppressed ? 'suppressed' : `assessed ${t.assessed}; mean HGI ${t.hgiMean ?? '-'}`]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '-';

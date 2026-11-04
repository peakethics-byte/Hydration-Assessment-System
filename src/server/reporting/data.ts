import type { Db, Tx } from '../db';
import { PermissionError } from '../roster';
import { OUTCOME_UNKNOWN, SCORED } from '../../domain/status';
import { ofTotal } from '../../domain/format';
import type { ScoringContent } from '../../methodology/types';
import {
  complementTooSmall, describeChange, metric, hidden, summarize, summarizeMatched, suppressTeams,
  type CohortRow, type GroupSummary, type MatchedRow, type MatchedSummary, type Metric,
} from '../../engine/aggregate';
import { hierarchyLabels, reportScope, type ReportScope } from './scope';
import { currentPeriod, periodsFor, threshold, type Period } from './periods';

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

export async function buildData(tx: Tx, scope: ReportScope, period: Period, filters: Filters): Promise<ReportData> {
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

  // A baseline-only view has no change to show.
  const matchedRows = filters.type === 'baseline' ? [] : await loadMatched(tx, scope.tenantId, period.start_date, period.end_date, teamIds);
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

export async function annualExtra(tx: Tx, scope: ReportScope, period: Period, data: ReportData): Promise<AnnualExtra> {
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
  const fmt = (m: Metric) => ofTotal(m, 'withheld (privacy)');
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

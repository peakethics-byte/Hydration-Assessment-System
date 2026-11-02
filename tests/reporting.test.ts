// Milestone 6: aggregation, dashboards, formal reports, periods, privacy suppression and exports
// (Document #5 Section 13 acceptance tests) - through the database and services, with fictional data.
import { beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { openDb, type Db } from '@/src/server/db';
import { seedDemo, type SeedIds } from '@/src/server/seed';
import { completeActionItem } from '@/src/server/assessment';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail } from '@/src/server/review';
import { closeMissedWindows, scheduleReassessment, OUTCOME_UNKNOWN } from '@/src/server/reassessment';
import { transferAthlete } from '@/src/server/history';
import { programPeriods } from '@/src/server/institution';
import {
  adjustPeriod, correctReport, dashboard, generateReport, getReport, periodsFor, recordExport, renewProgramYear, reportCsv, reportStep,
  saveNarrative, setThreshold, currentPeriod, ANNUAL,
} from '@/src/server/reporting';
import { renderReportPdf } from '@/src/server/report-pdf';
import { PermissionError } from '@/src/server/roster';
import { median, summarize } from '@/src/engine/aggregate';
import { A_SCR_1_0 } from '@/src/methodology/a-scr-1.0';
import { PROFILES } from '@/src/testing/fixtures';
import { newAthlete, takeAssessment } from '@/src/testing/harness';

let db: Db;
let ids: SeedIds;
const profile = (id: string) => PROFILES.find((p) => p.id === id)!.answers;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const pidOf = async (userId: string) =>
  (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [userId]))).rows[0].participant_id;

async function release(instanceId: string) {
  await markReviewed(db, ids.users.admin, instanceId);
  for (const r of (await reviewDetail(db, ids.users.admin, instanceId))!.recommendations) {
    await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'approve' });
  }
  await releaseResults(db, ids.users.admin, instanceId);
}

/** Text runs of an uncompressed PDF (pdfkit writes kerned hex pieces inside TJ arrays). */
function pdfRuns(pdf: Buffer): string[] {
  const s = pdf.toString('latin1');
  return [...s.matchAll(/\[((?:<[0-9a-f]*>\s*-?\d*\.?\d*\s*)+)\]\s*TJ/g)]
    .map((m) => [...m[1].matchAll(/<([0-9a-f]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join(''));
}

const track: { user: string; pid: string }[] = [];
let transferred: { user: string; pid: string };

beforeAll(async () => {
  db = await openDb();
  ids = await seedDemo(db);
  // Track & Field: six athletes take a baseline; five of them are reassessed (Matched Cohort of 5).
  for (const [i, p] of ['A', 'B', 'C', 'E', 'F', 'G'].entries()) {
    const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, `Rep${i}`);
    const pid = await pidOf(user);
    const b = await takeAssessment(db, user, profile(p));
    expect(b.result.ok).toBe(true);
    if (i < 3) await release(b.instanceId);
    track.push({ user, pid });
  }
  for (const t of track.slice(0, 5)) {
    await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [t.pid], targetStart: today(), targetEnd: plusDays(20) });
    await takeAssessment(db, t.user, profile('A'));
  }
  // Soccer: two athletes only (below the privacy threshold of 5).
  for (const [i, p] of ['A', 'C'].entries()) {
    const user = await newAthlete(db, ids.users.admin, ids.teams.soccer, `Soc${i}`);
    await takeAssessment(db, user, profile(p));
    if (i === 0) transferred = { user, pid: await pidOf(user) };
  }
  // One completed action item (intervention activity).
  const item = (await db.system((tx) => tx.query<{ action_item_id: string }>(
    'select action_item_id from action_item where participant_id = $1 limit 1', [track[1].pid]))).rows[0];
  await completeActionItem(db, track[1].user, item.action_item_id);
  // One missed reassessment window (Outcome Unknown).
  await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [track[5].pid], targetStart: today(), targetEnd: plusDays(5) });
  await db.system((tx) => tx.query(`update reassessment_schedule set target_start = current_date - 10, target_end = current_date - 1
    where participant_id = $1 and outcome = 'Scheduled'`, [track[5].pid]));
  await db.system((tx) => closeMissedWindows(tx));
});

const dash = (user = ids.users.admin, input = {}) => dashboard(db, user, ids.tenantA, input);

describe('Automatic reporting periods (Document #5 Section 3)', () => {
  it('TST-DAT-001: Sep 15, 2026 start gives the approved quarters and annual period', async () => {
    const p = programPeriods('2026-09-15');
    expect(p.quarters.map((q) => [q.type, q.start, q.end])).toEqual([
      ['Q1', '2026-09-15', '2026-12-14'], ['Q2', '2026-12-15', '2027-03-14'], ['Q3', '2027-03-15', '2027-06-14'], ['Q4', '2027-06-15', '2027-09-14'],
    ]);
    expect([p.annual.start, p.annual.end]).toEqual(['2026-09-15', '2027-09-14']);
    const stored = await db.system((tx) => periodsFor(tx, ids.tenantA));
    expect(stored.periods.find((x) => x.period_type === 'Annual')).toMatchObject({ start_date: '2026-09-15', end_date: '2027-09-14' });
  });

  it('TST-DAT-002: an authorized date change keeps original, revised, user, time and reason', async () => {
    const { periods } = await db.system((tx) => periodsFor(tx, ids.tenantB));
    const q4 = periods.find((p) => p.period_type === 'Q4')!;
    expect((await adjustPeriod(db, ids.users.adminB, { periodId: q4.period_id, start: '2027-06-15', end: '2027-09-10', reason: '' })).ok).toBe(false);
    expect((await adjustPeriod(db, ids.users.adminB, { periodId: q4.period_id, start: '2027-06-15', end: '2027-09-10', reason: 'Season ends early' })).ok).toBe(true);
    const c = (await db.system((tx) => tx.query<{ old_end: string; new_end: string; reason: string; changed_by: string; changed_at: string }>(
      'select old_end::text, new_end::text, reason, changed_by, changed_at::text from reporting_period_change where period_id = $1', [q4.period_id]))).rows[0];
    expect(c).toMatchObject({ old_end: '2027-09-14', new_end: '2027-09-10', reason: 'Season ends early', changed_by: ids.users.adminB });
    expect(c.changed_at).toBeTruthy();
    const after = (await db.system((tx) => periodsFor(tx, ids.tenantB))).periods.find((p) => p.period_type === 'Q4')!;
    expect([after.original_end, after.end_date]).toEqual(['2027-09-14', '2027-09-10']);
    // Only WeCanH2O administrators of that institution may change dates.
    await expect(adjustPeriod(db, ids.users.admin, { periodId: q4.period_id, start: '2027-06-15', end: '2027-09-11', reason: 'x' })).rejects.toThrow(PermissionError);
  });
});

describe('Dashboard aggregation (Document #5 Sections 2, 4, 5, 8)', () => {
  it('TST-REP-003: assessed / reassessed counts and completion rates match the stored records', async () => {
    const { data } = await dash();
    const expected = await db.system(async (tx) => (await tx.query<{ n: number; re: number }>(
      `select count(distinct participant_id)::int as n,
              count(distinct participant_id) filter (where not is_baseline)::int as re
       from assessment_instance where tenant_id = $1 and status in ('Complete / Scored', 'Reviewed', 'Released', 'Revalidated')`, [ids.tenantA])).rows[0]);
    expect(data.participation.assessed).toBe(expected.n);
    expect(data.participation.reassessed).toBe(expected.re);
    expect(data.participation.completion.n).toBe(expected.n);
    expect(data.participation.completion.d).toBe(data.participation.eligible);
    expect(data.participation.eligible).toBeGreaterThanOrEqual(expected.n);
  });

  it('TST-REP-004: average / median HGI and band counts match the cohort (latest valid assessment per athlete)', async () => {
    const { data } = await dash();
    const rows = (await db.system((tx) => tx.query<{ participant_id: string; hgi_internal: string; band: string }>(
      `select distinct on (i.participant_id) i.participant_id, h.hgi_internal::text, h.band from assessment_instance i join hgi_result h using (instance_id)
       where i.tenant_id = $1 and i.status in ('Complete / Scored', 'Reviewed', 'Released', 'Revalidated') and h.status = 'Calculated'
       order by i.participant_id, i.submitted_at desc`, [ids.tenantA]))).rows;
    const v = rows.map((r) => new Decimal(r.hgi_internal));
    const avg = v.reduce((a, b) => a.plus(b), new Decimal(0)).div(v.length).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
    expect(data.summary.hgiMean).toBe(avg);
    expect(data.summary.hgiMedian).toBe(median(v)!.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1));
    for (const b of data.summary.bands) expect(b.athletes.n).toBe(rows.filter((r) => r.band === b.band).length);
    expect(data.summary.assessed).toBe(rows.length);
  });

  it('TST-REP-005 / REP-029: Category 7 is contextual and never averaged into the HGI; no band labels on categories', async () => {
    const { data } = await dash();
    const c7 = data.summary.categories.find((c) => c.code === 'C7')!;
    expect(c7.contextual).toBe(true);
    expect(c7.meanPct).toBeNull();
    expect(A_SCR_1_0.hgiCategories).not.toContain('C7');
    expect(JSON.stringify(data.summary.categories)).not.toMatch(/Gap"/); // no "Mild Gap" etc. on categories
  });

  it('TST-REP-006 / 007: Matched Cohort and Full Assessment Population are separate, with numerators and denominators', async () => {
    const { data } = await dash();
    expect(data.matched.n).toBe(5);
    expect(data.fullPopulation.assessed).toBe(data.summary.assessed);
    expect(data.fullPopulation.assessed).not.toBe(data.matched.n);
    for (const m of [data.matched.higher, data.matched.same, data.matched.lower, ...data.matched.states.map((s) => s.athletes)]) {
      expect(m.d).toBe(5);
      expect(m.n).toBeGreaterThanOrEqual(0);
    }
    expect(data.matched.higher.n! + data.matched.same.n! + data.matched.lower.n!).toBe(5);
    const csv = reportCsv(data);
    expect(csv).toContain('matched_cohort,HGI higher');
  });

  it('TST-REP-008: an expected reassessment that was not completed is Outcome Unknown, never no change', async () => {
    const { data } = await dash();
    expect(data.reassessment.outcomeUnknown.n).toBe(1);
    expect(reportCsv(data)).toContain(`reassessment,Outcome Unknown,1`);
    const s = (await db.system((tx) => tx.query<{ outcome: string }>('select outcome from reassessment_schedule where participant_id = $1', [track[5].pid]))).rows;
    expect(s.map((x) => x.outcome)).toContain(OUTCOME_UNKNOWN);
  });

  it('TST-REP-009: an institutional / access finding is reported in the institutional section, not only as athlete behavior', async () => {
    const { data } = await dash(ids.users.admin, { type: 'baseline' });
    expect(data.summary.institutional.length).toBeGreaterThan(0);
    expect(data.summary.institutional.some((g) => g.category === 'C2' || (g.sourceClass ?? '').startsWith('Institutional'))).toBe(true);
  });

  it('TST-REP-010: a favorable HGI pattern does not suppress a safety / support priority', async () => {
    const { data } = await dash(ids.users.admin, { type: 'baseline' });
    expect(data.summary.safety.present).toBe(true);
    expect(data.priorities[0].kind).toBe('Safety / support');
    // Even inside a tiny group, the presence of a safety indicator is still reported (count withheld).
    const tiny = summarize([{ participantId: 'p', instanceId: 'i', teamId: null, isBaseline: true, submittedAt: '2026-10-01', asmVersion: 'A-ASM-1.0',
      hgiInternal: '95', categories: {}, findings: [{ ruleId: 'S', title: 'S', category: 'C6', sourceClass: 'Safety', priorityClass: 1, isSafety: true, isStrength: false }] },
    { participantId: 'q', instanceId: 'j', teamId: null, isBaseline: true, submittedAt: '2026-10-01', asmVersion: 'A-ASM-1.0', hgiInternal: '95', categories: {}, findings: [] }], A_SCR_1_0, 2);
    expect(tiny.safety).toMatchObject({ present: true, suppressed: true, n: null });
  });

  it('REP-014: team reports never expose names or symptom detail', async () => {
    const { data } = await dash(ids.users.coach);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/participant_id|Fixture|@fixture\.test|dizz|faint/i);
  });
});

describe('Privacy and scope (PRV-201..205)', () => {
  it('TST-PRV-001: a group below the threshold is suppressed on the dashboard, team comparison, filters and export', async () => {
    const { data } = await dash(ids.users.admin, { teamId: ids.teams.soccer });
    expect(data.summary.assessed).toBe(2);
    expect(data.summary.suppressed).toBe(true);
    expect(data.summary.hgiMean).toBeNull();
    const csv = reportCsv(data);
    expect(csv).toContain('all health figures,suppressed');
    const all = (await dash()).data;
    const soccer = all.teams.find((t) => t.name === 'Soccer')!;
    expect(soccer).toMatchObject({ suppressed: true, hgiMean: null });
    // Complementary suppression: with one team hidden, the other team is withheld too.
    expect(all.teams.find((t) => t.name === 'Track & Field')!.suppressed).toBe(true);
    // A filter whose complement is below the threshold is withheld as well (no differencing).
    const tf = (await dash(ids.users.admin, { teamId: ids.teams.trackField })).data;
    expect(tf.summary.suppressed).toBe(true);
    // The quarterly trend never shows a suppressed figure.
    for (const t of (await dash(ids.users.admin, { teamId: ids.teams.soccer })).data.trend) if (t.suppressed) expect(t.hgiMean).toBeNull();
  });

  it('threshold is configurable per institution', async () => {
    expect((await setThreshold(db, ids.users.admin, ids.tenantA, 0)).ok).toBe(false);
    expect((await setThreshold(db, ids.users.admin, ids.tenantA, 2)).ok).toBe(true);
    const tf = (await dash(ids.users.admin, { teamId: ids.teams.soccer })).data;
    expect(tf.summary.suppressed).toBe(false);
    await setThreshold(db, ids.users.admin, ids.tenantA, 5);
  });

  it('TST-PRV-002: Institution A users cannot reach Institution B dashboards, reports or exports', async () => {
    await expect(dashboard(db, ids.users.leader, ids.tenantB)).rejects.toThrow(PermissionError);
    await expect(dashboard(db, ids.users.adminB, ids.tenantA)).rejects.toThrow(PermissionError);
    await expect(recordExport(db, ids.users.adminB, { tenantId: ids.tenantA, format: 'CSV', context: {} })).rejects.toThrow(PermissionError);
    const { periods } = await db.system((tx) => periodsFor(tx, ids.tenantA));
    await expect(generateReport(db, ids.users.adminB, { tenantId: ids.tenantA, periodId: currentPeriod(periods).period_id })).rejects.toThrow(PermissionError);
  });

  it('coach sees only their own team; health support and athletes have no reporting access', async () => {
    const { data } = await dash(ids.users.coach);
    expect(data.participation.teams).toEqual(['Track & Field']);
    await expect(dash(ids.users.coach, { teamId: ids.teams.soccer })).rejects.toThrow(PermissionError);
    await expect(dash(ids.users.health)).rejects.toThrow(PermissionError);
    await expect(dash(track[0].user)).rejects.toThrow(PermissionError);
  });

  it('TST-AUD-001: an authorized export is logged with user, scope, time and format; export is a separate right', async () => {
    await recordExport(db, ids.users.admin, { tenantId: ids.tenantA, format: 'CSV', context: { kind: 'dashboard' } });
    const e = (await db.system((tx) => tx.query<{ user_id: string; tenant_id: string; occurred_at: string; new_value: { format: string; scope: unknown } }>(
      `select user_id, tenant_id, created_at::text as occurred_at, new_value from audit_event where action = 'export' order by event_id desc limit 1`))).rows[0];
    expect(e).toMatchObject({ user_id: ids.users.admin, tenant_id: ids.tenantA });
    expect(e.new_value.format).toBe('CSV');
    expect(e.new_value.scope).toBe('institution');
    expect(e.occurred_at).toBeTruthy();
    await expect(recordExport(db, ids.users.leader, { tenantId: ids.tenantA, format: 'CSV', context: {} })).rejects.toThrow(/separate right/);
  });
});

describe('Formal reports (Document #5 Sections 6, 7, 10, 11)', () => {
  let quarterId: string;
  let q1: string;

  it('TST-REP-001 / 002: a quarterly report auto-fills Program Year, quarter, exact dates and generation date, on every page', async () => {
    const { periods } = await db.system((tx) => periodsFor(tx, ids.tenantA));
    q1 = currentPeriod(periods).period_id;
    const g = await generateReport(db, ids.users.admin, { tenantId: ids.tenantA, periodId: q1 });
    expect(g.ok).toBe(true);
    quarterId = (g as { reportId: string }).reportId;
    const r = (await getReport(db, ids.users.admin, quarterId))!;
    const d = r.content.data;
    expect(r.status).toBe('Draft');
    expect(d.period).toMatchObject({ type: currentPeriod(periods).period_type, start: currentPeriod(periods).start_date, end: currentPeriod(periods).end_date,
      programYearStart: '2026-09-15', programYearEnd: '2027-09-14' });
    expect(r.generated_at).toBeTruthy();
    expect(r.rule_versions).toEqual(expect.arrayContaining(['A-ASM-1.0', 'A-SCR-1.0']));
    const buf = await renderReportPdf(r, { compress: false });
    const pages = (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    // Each page header names the institution and the quarter with its exact dates; each footer counts pages.
    const runs = pdfRuns(buf);
    const label = `Quarter ${d.period.type.slice(1)} - `;
    expect(runs.filter((t) => t.startsWith('Northbridge State University')).length).toBeGreaterThanOrEqual(pages);
    expect(runs.filter((t) => t.startsWith(label)).length).toBeGreaterThanOrEqual(pages);
    expect(runs.filter((t) => /^Page \d+ of \d+$/.test(t)).length).toBe(pages);
  });

  it('TST-REP-012: a report cannot be released before WeCanH2O approval', async () => {
    expect((await reportStep(db, ids.users.admin, quarterId, 'release')).ok).toBe(false);
    expect((await reportStep(db, ids.users.admin, quarterId, 'submit')).ok).toBe(false); // Section 9 is required first
    await saveNarrative(db, ids.users.admin, quarterId, { nextQuarterActions: 'Review water access at the practice field with athletics staff.' });
    expect((await reportStep(db, ids.users.admin, quarterId, 'submit')).ok).toBe(true);
    expect((await reportStep(db, ids.users.admin, quarterId, 'revise', '')).ok).toBe(false);
    expect((await reportStep(db, ids.users.admin, quarterId, 'revise', 'Please add the field note.')).ok).toBe(true);
    expect((await reportStep(db, ids.users.admin, quarterId, 'submit')).ok).toBe(true);
    // The database itself refuses a release without approval.
    await expect(db.system((tx) => tx.query(`update formal_report set status = 'Released' where report_id = $1`, [quarterId]))).rejects.toThrow(/approval/);
    expect((await reportStep(db, ids.users.admin, quarterId, 'approve')).ok).toBe(true);
    // Leaders see nothing until release.
    expect(await getReport(db, ids.users.leader, quarterId)).toBeNull();
    expect((await reportStep(db, ids.users.admin, quarterId, 'release')).ok).toBe(true);
    expect((await getReport(db, ids.users.leader, quarterId))!.status).toBe('Released');
    expect(await getReport(db, ids.users.adminB, quarterId)).toBeNull(); // other institution
  });

  it('TST-REP-011: a correction creates a superseding version and the released original is preserved', async () => {
    const before = (await getReport(db, ids.users.admin, quarterId))!;
    await expect(db.system((tx) => tx.query(`update formal_report set narrative = '{}' where report_id = $1`, [quarterId]))).rejects.toThrow(/locked/);
    await expect(db.system((tx) => tx.query('delete from formal_report where report_id = $1', [quarterId]))).rejects.toThrow(/never deleted/);
    expect((await correctReport(db, ids.users.admin, quarterId, '')).ok).toBe(false);
    const c = await correctReport(db, ids.users.admin, quarterId, 'Team list for Soccer was late');
    expect(c.ok).toBe(true);
    const newId = (c as { reportId: string }).reportId;
    await saveNarrative(db, ids.users.admin, newId, { nextQuarterActions: 'Review water access at the practice field with athletics staff.' });
    for (const s of ['submit', 'approve', 'release'] as const) expect((await reportStep(db, ids.users.admin, newId, s)).ok).toBe(true);
    const old = (await getReport(db, ids.users.admin, quarterId))!;
    const cur = (await getReport(db, ids.users.admin, newId))!;
    expect(old.status).toBe('Superseded');
    expect(old.content).toEqual(before.content);
    expect(old.narrative).toEqual(before.narrative);
    expect(cur).toMatchObject({ version: 2, report_number: before.report_number, supersedes_id: quarterId, status: 'Released' });
    const actions = (await db.system((tx) => tx.query<{ action: string }>(
      `select action from audit_event where record_type = 'formal_report' and record_id in ($1, $2)`, [quarterId, newId]))).rows.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['generate', 'submit', 'approve', 'release', 'correct', 'supersede']));
  });

  it('TST-DAT-003: renewal creates the next Program Year and leaves earlier periods and reports unchanged', async () => {
    const before = await db.system((tx) => periodsFor(tx, ids.tenantA));
    const reportsBefore = (await db.system((tx) => tx.query('select report_id, status, content from formal_report where tenant_id = $1 order by report_id', [ids.tenantA]))).rows;
    await renewProgramYear(db, ids.users.admin, ids.tenantA);
    const after = await db.system((tx) => periodsFor(tx, ids.tenantA));
    expect(after.years).toHaveLength(before.years.length + 1);
    expect(after.years[0]).toMatchObject({ program_start_date: '2027-09-15', program_end_date: '2028-09-14' });
    for (const p of before.periods) expect(after.periods.find((x) => x.period_id === p.period_id)).toEqual(p);
    expect((await db.system((tx) => tx.query('select report_id, status, content from formal_report where tenant_id = $1 order by report_id', [ids.tenantA]))).rows).toEqual(reportsBefore);
  });

  it('TST-REP-013: moving an athlete to a new team keeps earlier team aggregates historically correct', async () => {
    const before = (await dash(ids.users.admin, { periodId: q1 })).data;
    const soccerBefore = before.teams.find((t) => t.name === 'Soccer')!.assessed;
    await db.system((tx) => tx.query('update athlete_team_affiliation set effective_start = current_date - 30 where participant_id = $1', [transferred.pid]));
    await transferAthlete(db, ids.users.admin, transferred.pid, ids.teams.trackField, today());
    const after = (await dash(ids.users.admin, { periodId: q1 })).data;
    expect(after.teams.find((t) => t.name === 'Soccer')!.assessed).toBe(soccerBefore);
    expect(after.teams.find((t) => t.name === 'Track & Field')!.assessed).toBe(before.teams.find((t) => t.name === 'Track & Field')!.assessed);
  });

  it('TST-REP-014 / 015: the annual report separates the four outcome dimensions and makes no causal claims', async () => {
    const { periods } = await db.system((tx) => periodsFor(tx, ids.tenantA));
    const annual = periods.find((p) => p.period_type === 'Annual' && p.start_date === '2026-09-15')!;
    const g = await generateReport(db, ids.users.admin, { tenantId: ids.tenantA, periodId: annual.period_id });
    expect(g.ok).toBe(true);
    const r = (await getReport(db, ids.users.admin, (g as { reportId: string }).reportId))!;
    expect(r.report_type).toBe(ANNUAL);
    const o = r.content.annual!.outcomes;
    for (const dim of [o.athlete, o.environment, o.practices, o.engagement]) expect(dim.length).toBeGreaterThan(0);
    const generated = [r.content.data.changeText, r.content.annual!.yearEndText, ...r.content.data.priorities.map((p) => p.detail)].join(' ');
    expect(generated).not.toMatch(/\b(caus(e|ed|es)|due to|because of|result(ed)? (of|from)|led to|thanks to)\b/i);
    expect(r.content.data.changeText).toMatch(/observed/);
    expect((await reportStep(db, ids.users.admin, r.report_id, 'submit')).message).toMatch(/Executive Summary/);
    expect(pdfRuns(await renderReportPdf(r, { compress: false })).join(' ')).toContain('Outcome Dimensions');
  });
});

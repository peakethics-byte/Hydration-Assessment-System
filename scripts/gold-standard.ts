// Runs the Document #8 gold-standard cases through the real system (database, RLS, services) and
// writes test execution records in the Document #8 Section 30 format. The actual values are the
// stored backend values (TST-002), never screen values.
import fs from 'node:fs';
import path from 'node:path';
import { migrate, openDb, openHostedDb } from '../src/server/db';
import { seedDemo } from '../src/server/seed';
import { classifyHgi } from '../src/engine/scoring';
import { A_SCR_1_0 } from '../src/methodology/a-scr-1.0';
import { BASE, C3Q4_CASES, C4_CASES, HGI_CASES, PROFILES, type RawAnswers } from '../src/testing/fixtures';
import { newAthlete, storedResult, takeAssessment } from '../src/testing/harness';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail } from '../src/server/review';
import { athleteResult, draftMaintenance } from '../src/server/assessment';
import { scheduleReassessment, OUTCOME_UNKNOWN } from '../src/server/reassessment';
import { programPeriods } from '../src/server/institution';
import { correctReport, currentPeriod, dashboard, generateReport, getReport, periodsFor, reportStep, saveNarrative, setThreshold } from '../src/server/reporting';

interface RecordRow {
  testId: string;
  requirement: string;
  fixture: string;
  expected: string;
  actual: string;
  status: 'Passed' | 'Failed';
  note?: string;
}

const rows: RecordRow[] = [];
const add = (r: Omit<RecordRow, 'status'>, pass: boolean) => rows.push({ ...r, status: pass ? 'Passed' : 'Failed' });

async function main() {
  const startedAt = new Date();
  // In-memory and fictional. CHECK_HOSTED_URL runs the same checks through the hosted PostgreSQL driver.
  const hostedUrl = process.env.CHECK_HOSTED_URL;
  const db = hostedUrl ? openHostedDb(hostedUrl) : await openDb();
  if (hostedUrl) await migrate(db);
  const ids = await seedDemo(db);
  const admin = ids.users.admin;
  const team = ids.teams.trackField;

  // ---- Profiles A-J through the full system ----
  for (const p of PROFILES) {
    const athlete = await newAthlete(db, admin, team, `P${p.id}`);
    const { instanceId } = await takeAssessment(db, athlete, p.answers);
    const s = await storedResult(db, instanceId);
    const e = p.expected;
    const fixture = `Profile ${p.id} - ${p.name}${p.draftFixture ? ' (DRAFT fixture, Milestone 3 Section 6.2)' : ''}`;
    if (e.status !== 'scored') {
      const actual = `${s.validation.outcome}; missing ${s.validation.missing_items.join(', ')}; HGI ${s.hgi.hgi_display ?? 'not calculated'}; no category scores stored`;
      add({ testId: p.testIds.join(', '), requirement: 'LFC-013, TST-GS-J1..J3', fixture,
        expected: `Assessment Incomplete - HGI Not Calculated; missing ${e.missing!.join(', ')}; no HGI`, actual },
        s.validation.outcome === 'Assessment Incomplete - HGI Not Calculated' && s.hgi.hgi_display == null && s.cats.length === 0);
      continue;
    }
    const cats = Object.fromEntries(s.cats.map((c) => [c.category, c.score_display == null ? null : Number(c.score_display).toFixed(1)]));
    const expCats = Object.entries(e.categories!).map(([k, v]) => `${k} ${v}`).join(', ');
    const actCats = Object.keys(e.categories!).map((k) => `${k} ${cats[k]}`).join(', ');
    add({ testId: `${p.testIds[0]} (scoring)`, requirement: 'Document #1; TST-GS', fixture,
      expected: `${expCats}; HGI ${e.hgiDisplay}; ${e.band}`,
      actual: `${actCats}; HGI ${Number(s.hgi.hgi_display).toFixed(1)} (internal ${s.hgi.hgi_internal}); ${s.hgi.band}` },
      actCats === expCats && Number(s.hgi.hgi_display).toFixed(1) === e.hgiDisplay && s.hgi.band === e.band);

    const found = s.findings.filter((f) => f.finding_type !== 'strength');
    const expF = e.findings!.map(([r, c]) => `${r} (${c})`).join(' > ') || 'none';
    const actF = found.map((f) => `${f.rule_id} (${f.priority_class})`).join(' > ') || 'none';
    const expS = e.strengths!.join(', ');
    const actS = s.findings.filter((f) => f.finding_type === 'strength').map((f) => f.category).join(', ');
    add({ testId: `${p.testIds[0]} (HGA)`, requirement: 'Document #3; TST-GS-H1..H3', fixture,
      expected: `Findings in order: ${expF}; strengths ${expS}`, actual: `Findings in order: ${actF}; strengths ${actS}` },
      expF === actF && expS === actS);

    const expP = Object.entries(e.pathways ?? {}).map(([r, pw]) => `${r}->${pw}`).join(', ') || 'none';
    const actP = s.recs.filter((r) => e.pathways?.[r.rule_id]).map((r) => `${r.rule_id}->${r.pathway}`).join(', ') || 'none';
    const product = s.recs.some((r) => r.pathway === 'F');
    add({ testId: `${p.testIds[0]} (IHS)`, requirement: 'IHS-003..IHS-011; TST-IHS-001..006', fixture,
      expected: `Pathways ${expP}; no product (F); all Suggested by Rules Engine`,
      actual: `Pathways ${actP}; product ${product ? 'PRESENT' : 'none'}; statuses ${[...new Set(s.recs.map((r) => r.status))].join(', ') || 'n/a'}` },
      expP === actP && !product && s.recs.every((r) => r.status === 'Suggested by Rules Engine'));

    add({ testId: 'TST-005', requirement: 'Exact versioning', fixture,
      expected: 'A-ASM-1.0 / A-SCR-1.0 / A-HGA-1.0 / A-REC-1.0 stored on the record',
      actual: [s.inst.asm_version_id, s.inst.scr_version_id, s.inst.hga_version_id, s.inst.rec_version_id].join(' / ') },
      [s.inst.asm_version_id, s.inst.scr_version_id, s.inst.hga_version_id, s.inst.rec_version_id].join() === 'A-ASM-1.0,A-SCR-1.0,A-HGA-1.0,A-REC-1.0');
  }

  // Paired records (TST-GS-D1, I1).
  const hgiOf = async (raw: RawAnswers, label: string) => {
    const a = await newAthlete(db, admin, team, label);
    const { instanceId } = await takeAssessment(db, a, raw);
    return (await storedResult(db, instanceId)).hgi.hgi_internal;
  };
  for (const [testId, x, y] of [['TST-GS-D1', 'D1', 'D2'], ['TST-GS-I1', 'I1', 'I2']] as const) {
    const hx = await hgiOf(PROFILES.find((p) => p.id === x)!.answers, `${x}b`);
    const hy = await hgiOf(PROFILES.find((p) => p.id === y)!.answers, `${y}b`);
    add({ testId, requirement: 'Exposure / C7 never change HGI', fixture: `Profiles ${x} and ${y}`, expected: 'Identical internal HGI', actual: `${hx} and ${hy}` }, hx === hy);
  }

  // ---- C4 normalization ----
  for (const c of C4_CASES) {
    const a = await newAthlete(db, admin, team, c.id);
    const { instanceId, result } = await takeAssessment(db, a, { ...BASE, ...c.answers } as RawAnswers);
    const s = await storedResult(db, instanceId);
    const c4 = s.cats.find((x) => x.category === 'C4');
    const actual = result.ok ? `C4 ${Number(c4!.score_display).toFixed(1)} (internal ${c4!.score_internal})` : `${result.statusLabel}; HGI not calculated`;
    const expected = c.expected.status === 'scored' ? `C4 ${c.expected.display}` : c.expected.status === 'insufficient_c4' ? 'Insufficient Category 4 Data; HGI not calculated' : 'Assessment Incomplete - HGI Not Calculated';
    const pass = c.expected.status === 'scored'
      ? result.ok && Number(c4!.score_display).toFixed(1) === c.expected.display
      : !result.ok && result.statusLabel === (c.expected.status === 'insufficient_c4' ? 'Insufficient Category 4 Data' : 'Assessment Incomplete - HGI Not Calculated') && s.hgi.hgi_display == null;
    add({ testId: c.id, requirement: 'Document #1 C4; TST-C4-007/008', fixture: JSON.stringify(c.answers), expected, actual }, pass);
  }

  // ---- C3Q4 lower-of ----
  for (const c of C3Q4_CASES) {
    const a = await newAthlete(db, admin, team, c.id);
    const { instanceId } = await takeAssessment(db, a, { ...BASE, Q15A: c.q15a, Q15B: c.q15b });
    const s = await storedResult(db, instanceId);
    const c3 = Number(s.cats.find((x) => x.category === 'C3')!.score_internal);
    const c3q4 = c3 - 12; // the other four C3 items are 3 each in the base set
    const both = (await db.system((tx) => tx.query<{ item_code: string; points: string }>(
      `select item_code, points from item_response where instance_id = $1 and item_code in ('Q15A','Q15B') order by item_code`, [instanceId]))).rows;
    add({ testId: c.id, requirement: 'C3Q4 lower-of; TST-C3Q4-006/007', fixture: `Q15A=${c.q15a}, Q15B=${c.q15b}`,
      expected: `C3Q4 ${c.expected}; both answers stored`, actual: `C3Q4 ${c3q4}; stored Q15A=${both[0]?.points}, Q15B=${both[1]?.points}` },
      c3q4 === c.expected && both.length === 2 && Number(both[0].points) === Number(c.q15a) && Number(both[1].points) === Number(c.q15b));
  }

  // ---- HGI boundaries and rounding (scoring rule A-SCR-1.0) ----
  for (const c of HGI_CASES) {
    const r = classifyHgi(c.internal, A_SCR_1_0);
    add({ testId: c.id, requirement: 'TST-HGI-009..011; band from displayed value (Oct 8 decision)', fixture: `Internal HGI ${c.internal}`,
      expected: `${c.display} ${c.band}`, actual: `${r.display} ${r.band}`, note: 'Round half up to one decimal (decimal arithmetic)' },
      r.display === c.display && r.band === c.band);
  }

  // ---- Review gate and release (TST-IHS-007/008) ----
  const gateAthlete = await newAthlete(db, admin, team, 'Gate');
  const gate = await takeAssessment(db, gateAthlete, PROFILES.find((p) => p.id === 'E')!.answers);
  const before = await athleteResult(db, gateAthlete);
  add({ testId: 'TST-IHS-007', requirement: 'Review gate', fixture: 'Profile E', expected: 'Athlete sees nothing before approval', actual: before ? 'Results visible' : 'No results visible' }, before == null);
  let techDenied = false;
  const det = (await reviewDetail(db, admin, gate.instanceId))!;
  try { await decideRecommendation(db, ids.users.tech, { recId: det.recommendations[0].rec_id, decision: 'approve' }); } catch { techDenied = true; }
  add({ testId: 'TST-ROL-005', requirement: 'ROL; IHS-015', fixture: 'Profile E', expected: 'Technical admin approval denied', actual: techDenied ? 'Denied' : 'Allowed' }, techDenied);
  await markReviewed(db, admin, gate.instanceId);
  for (const r of det.recommendations) await decideRecommendation(db, admin, { recId: r.rec_id, decision: 'approve' });
  await releaseResults(db, admin, gate.instanceId);
  const after = await athleteResult(db, gateAthlete);
  const statuses = (await storedResult(db, gate.instanceId)).recs.map((r) => r.status).join(', ');
  add({ testId: 'TST-IHS-008 / TST-GS-E1', requirement: 'IHS-014; HGA-012', fixture: 'Profile E',
    expected: 'Suggested -> Reviewed -> Approved -> Assigned / Delivered; safety priority shown; HGI 99.0 Minimal Gap',
    actual: `${statuses}; first priority safety=${after?.priorities[0]?.isSafety}; HGI ${after?.hgiDisplay} ${after?.band}` },
    statuses === 'Assigned / Delivered' && after?.priorities[0]?.isSafety === true && after?.hgiDisplay === '99.0');
  const leak = JSON.stringify(after).match(/HGA-|A-HGA|A-SCR|points|weight/i);
  add({ testId: 'ROL / F8', requirement: 'Athletes never see rule IDs, weights or formulas', fixture: 'Profile E released result',
    expected: 'No rule IDs, weights, formulas', actual: leak ? `Found "${leak[0]}"` : 'None present' }, !leak);

  // ---- Reassessment / change pairs (Milestone 3 Section 6.4; Document #8 Section 20) ----
  const C1 = (v: string) => Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].map((q) => [q, v]));
  const P = (id: string) => PROFILES.find((x) => x.id === id)!.answers;
  const today = new Date().toISOString().slice(0, 10);
  const later = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const pairs: { id: string; baseline: RawAnswers; current: RawAnswers; hgi: string; states: Record<string, string> }[] = [
    { id: 'TST-CHG-001 Improved', baseline: { ...BASE, ...C1('0') }, current: { ...BASE, ...C1('1') }, hgi: '+5.0', states: { 'HGA-C1': 'Improved', 'HGA-X03': 'Improved' } },
    { id: 'TST-CHG-002 Resolved', baseline: P('B'), current: P('A'), hgi: '+20.0', states: { 'HGA-X03': 'Resolved', 'HGA-C1': 'Resolved' } },
    { id: 'TST-CHG-003 Persistent', baseline: P('C'), current: P('C'), hgi: '+0.0', states: { 'HGA-C2': 'Persistent' } },
    { id: 'TST-CHG-004 Worsened', baseline: { ...BASE, ...C1('2') }, current: { ...BASE, ...C1('0') }, hgi: '-10.0', states: { 'HGA-C1': 'Worsened', 'HGA-X03': 'Worsened' } },
    { id: 'TST-CHG-005 New', baseline: P('A'), current: P('B'), hgi: '-20.0', states: { 'HGA-X03': 'New', 'HGA-C1': 'New' } },
    { id: 'TST-CHG-006 HGI delta', baseline: P('H'), current: P('A'), hgi: '+37.5', states: {} },
    { id: 'TST-CHG-007 Safety despite improvement', baseline: P('B'), current: P('E'), hgi: '+19.0', states: { 'HGA-X03': 'Resolved', 'HGA-X05': 'New' } },
    { id: 'TST-CHG-010 C7 change', baseline: P('I2'), current: P('I1'), hgi: '+0.0', states: { 'HGA-C7': 'New' } },
  ];
  for (const pr of pairs) {
    const a = await newAthlete(db, admin, team, pr.id.split(' ')[0]);
    const pid = (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [a]))).rows[0].participant_id;
    const b = await takeAssessment(db, a, pr.baseline);
    await scheduleReassessment(db, admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today, targetEnd: later });
    const c = await takeAssessment(db, a, pr.current);
    const stored = await db.system(async (tx) => {
      const ca = (await tx.query<{ change_analysis_id: string; hgi_change: string; comparison_status: string }>(
        'select change_analysis_id, hgi_change::text, comparison_status from change_analysis where current_instance_id = $1 and superseded_at is null', [c.instanceId])).rows[0];
      const fc = (await tx.query<{ rule_id: string; state: string }>('select rule_id, state from finding_change where change_analysis_id = $1', [ca.change_analysis_id])).rows;
      const two = (await tx.query<{ n: number }>('select count(*)::int n from assessment_instance where participant_id = $1', [pid])).rows[0].n;
      return { ca, fc: Object.fromEntries(fc.map((f) => [f.rule_id, f.state])), two };
    });
    const hgi = `${Number(stored.ca.hgi_change) >= 0 ? '+' : ''}${Number(stored.ca.hgi_change).toFixed(1)}`;
    const expStates = Object.entries(pr.states).map(([k, v]) => `${k} ${v}`).join(', ') || 'all baseline findings Resolved';
    const actStates = Object.keys(pr.states).length ? Object.keys(pr.states).map((k) => `${k} ${stored.fc[k] ?? 'none'}`).join(', ')
      : (Object.values(stored.fc).every((v) => v === 'Resolved') ? 'all baseline findings Resolved' : JSON.stringify(stored.fc));
    add({ testId: pr.id, requirement: 'Document #4 CHG-004..013; REA-001', fixture: `Baseline and reassessment for one fictional athlete (${b.instanceId !== c.instanceId ? 'two separate instances' : 'SAME INSTANCE'})`,
      expected: `HGI change ${pr.hgi}; ${expStates}`, actual: `HGI change ${hgi} (internal ${stored.ca.hgi_change}); ${actStates}` },
      hgi === pr.hgi && expStates === actStates && stored.two === 2);
  }
  // TST-CHG-009 missing reassessment.
  {
    const a = await newAthlete(db, admin, team, 'Missed');
    const pid = (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [a]))).rows[0].participant_id;
    await takeAssessment(db, a, P('A'));
    await scheduleReassessment(db, admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today, targetEnd: later });
    await db.system((tx) => tx.query('update reassessment_schedule set target_start = current_date - 30, target_end = current_date - 1 where participant_id = $1', [pid]));
    await draftMaintenance(db);
    const o = (await db.system((tx) => tx.query<{ outcome: string }>('select outcome from reassessment_schedule where participant_id = $1', [pid]))).rows[0].outcome;
    add({ testId: 'TST-CHG-009 Missing reassessment', requirement: 'Document #4 REA-010, CHG-023', fixture: 'Profile A baseline; window closes without a reassessment',
      expected: OUTCOME_UNKNOWN, actual: o }, o === OUTCOME_UNKNOWN);
  }

  // ---- Milestone 6: aggregation and formal reports (Document #5 Section 13) ----
  {
    const p = programPeriods('2026-09-15');
    const got = [...p.quarters.map((q) => `${q.type} ${q.start}..${q.end}`), `Annual ${p.annual.start}..${p.annual.end}`].join('; ');
    const exp = 'Q1 2026-09-15..2026-12-14; Q2 2026-12-15..2027-03-14; Q3 2027-03-15..2027-06-14; Q4 2027-06-15..2027-09-14; Annual 2026-09-15..2027-09-14';
    add({ testId: 'TST-DAT-001', requirement: 'Document #5 DAT-001..005', fixture: 'Program Start Date September 15, 2026', expected: exp, actual: got }, got === exp);

    // Lakeview (fictional): five athletes with hand-calculated HGIs 100, 80, 85, 90, 62.5; one more listed but not assessed.
    const adminB = ids.users.adminB;
    for (const id of ['A', 'B', 'C', 'F', 'H']) {
      const a = await newAthlete(db, adminB, ids.teams.lakeviewBasketball, `Lv${id}`);
      await takeAssessment(db, a, P(id));
    }
    const d = (await dashboard(db, adminB, ids.tenantB)).data;
    const bands = d.summary.bands.filter((b) => b.athletes.n).map((b) => `${b.band} ${b.athletes.n}`).join(', ');
    add({ testId: 'TST-REP-003', requirement: 'Document #5 REP-020', fixture: 'Lakeview: 6 on the team list, 5 assessed',
      expected: 'eligible 6; assessed 5; completion 5 of 6 (83.3%)',
      actual: `eligible ${d.participation.eligible}; assessed ${d.participation.assessed}; completion ${d.participation.completion.n} of ${d.participation.completion.d} (${d.participation.completion.pct}%)` },
      d.participation.eligible === 6 && d.participation.assessed === 5 && d.participation.completion.pct === '83.3');
    add({ testId: 'TST-REP-004', requirement: 'Document #5 REP-027', fixture: 'HGIs 100.0, 80.0, 85.0, 90.0, 62.5',
      expected: 'average 83.5; median 85.0; Minimal Gap 2, Mild Gap 2, Moderate Gap 1',
      actual: `average ${d.summary.hgiMean}; median ${d.summary.hgiMedian}; ${bands}` },
      d.summary.hgiMean === '83.5' && d.summary.hgiMedian === '85.0' && bands === 'Minimal Gap 2, Mild Gap 2, Moderate Gap 1');
    const c7 = d.summary.categories.find((c) => c.code === 'C7')!;
    add({ testId: 'TST-REP-005', requirement: 'Document #5 REP-018', fixture: 'Same cohort', expected: 'C7 contextual, no average, not in HGI',
      actual: `C7 contextual=${c7.contextual}; average ${c7.meanPct ?? 'none'}` }, c7.contextual && c7.meanPct == null);
    add({ testId: 'TST-REP-010', requirement: 'Document #5 REP-031', fixture: 'Average HGI 83.5 (favorable) with one safety finding (profile H)',
      expected: 'safety / support listed first; count withheld (1 is below 5)', actual: `first priority: ${d.priorities[0]?.kind}; present=${d.summary.safety.present}; count ${d.summary.safety.n ?? 'withheld'}` },
      d.priorities[0]?.kind === 'Safety / support' && d.summary.safety.present && d.summary.safety.n == null);

    await setThreshold(db, adminB, ids.tenantB, 6);
    const hiddenD = (await dashboard(db, adminB, ids.tenantB)).data;
    add({ testId: 'TST-PRV-001', requirement: 'Document #5 PRV-202/203', fixture: 'Threshold raised to 6; 5 assessed',
      expected: 'health figures withheld; participation shown', actual: `suppressed=${hiddenD.summary.suppressed}; average ${hiddenD.summary.hgiMean ?? 'withheld'}; assessed ${hiddenD.summary.assessed}` },
      hiddenD.summary.suppressed && hiddenD.summary.hgiMean == null && hiddenD.summary.assessed === 5);
    await setThreshold(db, adminB, ids.tenantB, 5);

    let denied = false;
    try { await dashboard(db, adminB, ids.tenantA); } catch { denied = true; }
    add({ testId: 'TST-PRV-002', requirement: 'Document #5 PRV-205', fixture: 'Lakeview administrator opens the Northbridge dashboard', expected: 'access denied', actual: denied ? 'access denied' : 'visible' }, denied);

    const { periods } = await db.system((tx) => periodsFor(tx, ids.tenantB));
    const g = await generateReport(db, adminB, { tenantId: ids.tenantB, periodId: currentPeriod(periods).period_id });
    const rid = g.ok ? g.reportId : '';
    const early = await reportStep(db, adminB, rid, 'release');
    add({ testId: 'TST-REP-012', requirement: 'Document #5 REP-033', fixture: 'Draft quarterly report', expected: 'release refused before approval',
      actual: early.ok ? 'released' : 'release refused' }, !early.ok);
    await saveNarrative(db, adminB, rid, { nextQuarterActions: 'Fictional next-quarter action for testing.' });
    for (const st of ['submit', 'approve', 'release'] as const) await reportStep(db, adminB, rid, st);
    const r1 = (await getReport(db, adminB, rid))!;
    add({ testId: 'TST-REP-001', requirement: 'Document #5 REP-016', fixture: 'Generated quarterly report',
      expected: `Program Year 2026-09-15..2027-09-14; ${currentPeriod(periods).period_type} ${currentPeriod(periods).start_date}..${currentPeriod(periods).end_date}; generation date set`,
      actual: `Program Year ${r1.content.data.period.programYearStart}..${r1.content.data.period.programYearEnd}; ${r1.content.data.period.type} ${r1.content.data.period.start}..${r1.content.data.period.end}; generated ${r1.generated_at ? 'yes' : 'no'}` },
      r1.content.data.period.programYearStart === '2026-09-15' && r1.content.data.period.start === currentPeriod(periods).start_date && Boolean(r1.generated_at));
    const c = await correctReport(db, adminB, rid, 'Fictional correction for testing');
    const cid = c.ok ? c.reportId : '';
    await saveNarrative(db, adminB, cid, { nextQuarterActions: 'Fictional next-quarter action for testing.' });
    for (const st of ['submit', 'approve', 'release'] as const) await reportStep(db, adminB, cid, st);
    const old = (await getReport(db, adminB, rid))!;
    const cur = (await getReport(db, adminB, cid))!;
    add({ testId: 'TST-REP-011', requirement: 'Document #5 REP-034/035', fixture: 'Released report, then a correction',
      expected: 'v1 Superseded with unchanged content; v2 Released, supersedes v1',
      actual: `v${old.version} ${old.status} (content unchanged: ${JSON.stringify(old.content) === JSON.stringify(r1.content)}); v${cur.version} ${cur.status}, supersedes v1: ${cur.supersedes_id === rid}` },
      old.status === 'Superseded' && JSON.stringify(old.content) === JSON.stringify(r1.content) && cur.status === 'Released' && cur.supersedes_id === rid && cur.version === 2);
  }

  // ---- Write the evidence ----
  const outDir = path.join(process.cwd(), process.env.GOLD_OUT ?? 'test-evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const passed = rows.filter((r) => r.status === 'Passed').length;
  const meta = {
    environment: hostedUrl ? 'Hosted driver (node-postgres) against a local PostgreSQL wire server' : 'Development (local, in-memory PostgreSQL / PGlite)',
    build: `wecanh2o-hydration-assessment ${JSON.parse(fs.readFileSync('package.json', 'utf8')).version}`,
    versions: 'A-ASM-1.0, A-SCR-1.0, A-HGA-1.0 (DRAFT fixture), A-REC-1.0 (DRAFT fixture)',
    tester: 'Automated run, reviewed by Gwen Lavarias',
    date: startedAt.toISOString(),
    total: rows.length,
    passed,
  };
  fs.writeFileSync(path.join(outDir, 'gold-standard-results.json'), JSON.stringify({ meta, rows }, null, 2));
  const md = [
    '# Gold-Standard Test Execution Record - Milestones 4 to 6',
    '',
    `Environment: ${meta.environment}  `,
    `Build: ${meta.build}  `,
    `Rule versions: ${meta.versions}  `,
    `Tester: ${meta.tester}  `,
    `Date: ${meta.date}  `,
    `Result: ${passed} of ${rows.length} passed`,
    '',
    'All fixtures are fictional. Expected values were calculated by hand (Milestone 3 Section 6). Actual values are the stored backend values.',
    'Status "Passed" means Passed Testing. Only WeCanH2O can set Accepted (ACC-001).',
    '',
    '| Test ID | Requirement | Fixture | Expected | Actual | Status |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.testId} | ${r.requirement} | ${r.fixture.replace(/\|/g, '/')} | ${r.expected} | ${r.actual}${r.note ? ` (${r.note})` : ''} | ${r.status} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'gold-standard-results.md'), md);
  await db.close();
  console.log(`${passed} of ${rows.length} gold-standard checks passed. Evidence written to ${outDir}`);
  if (passed !== rows.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

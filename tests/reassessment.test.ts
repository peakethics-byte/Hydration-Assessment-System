// Milestone 5 end-to-end: reassessment workflow, change analysis, history, search, transfers,
// duplicate linking and explicit access grants - through the database, RLS and services (fictional data).
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/src/server/db';
import { seedDemo, registerAthlete, type SeedIds, DEV_PASSWORD } from '@/src/server/seed';
import { athleteResult, completeActionItem, draftMaintenance, openAssessment } from '@/src/server/assessment';
import { scheduleReassessment, cancelSchedule, OUTCOME_UNKNOWN } from '@/src/server/reassessment';
import { athleteHistory, grantAccess, resolveDuplicate, revokeAccess, searchAthletes, transferAthlete } from '@/src/server/history';
import { correctResponse } from '@/src/server/corrections';
import { uploadRoster } from '@/src/server/roster';
import { login } from '@/src/server/auth';
import { PROFILES } from '@/src/testing/fixtures';
import { newAthlete, storedResult, takeAssessment } from '@/src/testing/harness';
import { approveAndRelease } from '@/src/testing/harness';

let db: Db;
let ids: SeedIds;
const profile = (id: string) => PROFILES.find((p) => p.id === id)!.answers;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const participantOf = async (userId: string) =>
  (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [userId]))).rows[0].participant_id;

const release = (instanceId: string) => approveAndRelease(db, ids.users.admin, instanceId);

/** Baseline -> window -> reassessment, returning both instance ids. */
async function baselineAndReassess(label: string, first: string, second: string, opts: { releaseBaseline?: boolean } = {}) {
  const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, label);
  const pid = await participantOf(user);
  const base = await takeAssessment(db, user, profile(first));
  if (opts.releaseBaseline) await release(base.instanceId);
  const s = await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(30) });
  expect(s.scheduled).toHaveLength(1);
  const re = await takeAssessment(db, user, profile(second));
  return { user, pid, baseId: base.instanceId, reId: re.instanceId, reResult: re.result };
}

const analysisOf = (instanceId: string) => db.system(async (tx) => {
  const ca = (await tx.query<{ change_analysis_id: string; comparison_status: string; hgi_change: string | null }>(
    'select change_analysis_id, comparison_status, hgi_change::text from change_analysis where current_instance_id = $1 and superseded_at is null', [instanceId])).rows[0];
  const states = ca ? (await tx.query<{ rule_id: string; state: string; priority_class: number; is_safety: boolean }>(
    'select rule_id, state, priority_class, is_safety from finding_change where change_analysis_id = $1', [ca.change_analysis_id])).rows : [];
  return { ca, states: Object.fromEntries(states.map((s) => [s.rule_id, s.state])), rows: states };
});

beforeAll(async () => {
  db = await openDb();
  ids = await seedDemo(db);
});

describe('Reassessment workflow (Document #4 REA-001..010)', () => {
  it('TST-REA-001/003: baseline and reassessment are separate instances; target window and actual date stored separately', async () => {
    const r = await baselineAndReassess('ReaB', 'B', 'A');
    expect(r.reId).not.toBe(r.baseId);
    expect(r.reResult.ok).toBe(true);
    const base = await storedResult(db, r.baseId);
    expect(base.hgi.hgi_display).toBe('80.0'); // baseline unchanged (REA-002)
    const rows = (await db.system((tx) => tx.query<{ instance_id: string; is_baseline: boolean; schedule_id: string | null }>(
      'select instance_id, is_baseline, schedule_id from assessment_instance where participant_id = $1 order by submitted_at', [r.pid]))).rows;
    expect(rows.map((x) => x.is_baseline)).toEqual([true, false]);
    const s = (await db.system((tx) => tx.query<{ outcome: string; target_start: string; target_end: string; actual_instance_id: string; submitted_at: string }>(
      `select s.outcome, s.target_start::text, s.target_end::text, s.actual_instance_id, i.submitted_at::text
       from reassessment_schedule s join assessment_instance i on i.instance_id = s.actual_instance_id where s.participant_id = $1`, [r.pid]))).rows[0];
    expect(s).toMatchObject({ outcome: 'Completed', target_start: today(), target_end: plusDays(30), actual_instance_id: r.reId });
    expect(s.submitted_at).toBeTruthy();
  });

  it('change since baseline is stored: HGI change from internal values, Resolved findings (B -> A)', async () => {
    const r = await baselineAndReassess('ReaB2', 'B', 'A');
    const a = await analysisOf(r.reId);
    expect(a.ca).toMatchObject({ comparison_status: 'Comparable', hgi_change: '20' });
    expect(a.states).toMatchObject({ 'HGA-X03': 'Resolved', 'HGA-C1': 'Resolved' });
  });

  it('a repeated behavioral gap is Persistent and moves to priority class 4 (B -> B)', async () => {
    const r = await baselineAndReassess('ReaPersist', 'B', 'B');
    const a = await analysisOf(r.reId);
    expect(a.states).toMatchObject({ 'HGA-C1': 'Persistent', 'HGA-X03': 'Persistent' });
    const cur = await storedResult(db, r.reId);
    expect(cur.findings.find((f) => f.rule_id === 'HGA-C1')?.priority_class).toBe(4);
    expect((await storedResult(db, r.baseId)).findings.find((f) => f.rule_id === 'HGA-C1')?.priority_class).toBe(6);
  });

  it('TST-CHG-006/007: HGI improves while a new safety finding appears; the safety finding stays first', async () => {
    const r = await baselineAndReassess('ReaSafety', 'B', 'E');
    const a = await analysisOf(r.reId);
    expect(a.ca.hgi_change).toBe('19');
    expect(a.states['HGA-X05']).toBe('New');
    expect(a.states['HGA-X03']).toBe('Resolved');
    const h = await athleteHistory(db, ids.users.admin, r.pid);
    expect(h!.findingChanges.find((f) => f.is_safety)?.state).toBe('New');
  });

  it('only one open window per athlete; no window without a baseline; windows can be cancelled', async () => {
    const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, 'ReaRules');
    const pid = await participantOf(user);
    const none = await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(10) });
    expect(none.skipped[0].reason).toMatch(/baseline/);
    await takeAssessment(db, user, profile('A'));
    await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(10) });
    const twice = await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(10) });
    expect(twice.skipped[0].reason).toMatch(/already open/);
    await expect(scheduleReassessment(db, ids.users.coach, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(10) })).rejects.toThrow(/permission/);
    const sid = (await db.system((tx) => tx.query<{ schedule_id: string }>(`select schedule_id from reassessment_schedule where participant_id = $1 and outcome = 'Scheduled'`, [pid]))).rows[0].schedule_id;
    await cancelSchedule(db, ids.users.admin, sid);
    const inst = await openAssessment(db, user); // no open window -> the athlete stays on the completed baseline
    expect(inst.status).toBe('Complete / Scored');
  });

  it('a future window does not open the reassessment early', async () => {
    const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, 'ReaFuture');
    const pid = await participantOf(user);
    const base = await takeAssessment(db, user, profile('A'));
    await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: plusDays(5), targetEnd: plusDays(20) });
    expect((await openAssessment(db, user)).instance_id).toBe(base.instanceId);
  });

  it('TST-REA-004 / TST-CHG-009: a missed window is "Reassessment Not Completed / Outcome Unknown", never "no change"', async () => {
    const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, 'ReaMissed');
    const pid = await participantOf(user);
    await takeAssessment(db, user, profile('A'));
    await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(5) });
    await db.system((tx) => tx.query(`update reassessment_schedule set target_start = current_date - 20, target_end = current_date - 1 where participant_id = $1`, [pid]));
    const m = await draftMaintenance(db);
    expect(m.missedReassessments).toBeGreaterThanOrEqual(1);
    const s = (await db.system((tx) => tx.query<{ outcome: string }>('select outcome from reassessment_schedule where participant_id = $1', [pid]))).rows[0];
    expect(s.outcome).toBe(OUTCOME_UNKNOWN);
    expect((await analysisOf((await openAssessment(db, user)).instance_id)).ca).toBeUndefined(); // no invented change
    const rows = await searchAthletes(db, ids.users.admin, { reassessment: 'unknown' });
    expect(rows.map((r) => r.participant_id)).toContain(pid);
  });

  it('TST-CHG-002/008: a different assessment version without an approved mapping is "Review Required", with no numbers or states', async () => {
    await db.system(async (tx) => {
      await tx.query(`update rule_version set status = 'Retired' where rule_version_id = 'A-ASM-1.0'`);
      await tx.query(`insert into rule_version (rule_version_id, population_code, family, version_label, status, is_fixture, content)
        select 'A-ASM-9.9', 'A', 'ASM', '9.9', 'Active', true, content from rule_version where rule_version_id = 'A-ASM-1.0'`);
      await tx.query(`insert into assessment_item (asm_version_id, item_code, construct, part, category, item_type, is_scored, required, na_allowed, optional, multi_select, prompt, options, display_order)
        select 'A-ASM-9.9', item_code, construct, part, category, item_type, is_scored, required, na_allowed, optional, multi_select, prompt, options, display_order
        from assessment_item where asm_version_id = 'A-ASM-1.0'`);
    });
    try {
      const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, 'ReaVersion');
      const pid = await participantOf(user);
      await db.system((tx) => tx.query(`update rule_version set status = 'Active' where rule_version_id = 'A-ASM-1.0'`));
      await db.system((tx) => tx.query(`update rule_version set status = 'Retired' where rule_version_id = 'A-ASM-9.9'`));
      await takeAssessment(db, user, profile('A')); // baseline on A-ASM-1.0
      await db.system((tx) => tx.query(`update rule_version set status = case rule_version_id when 'A-ASM-9.9' then 'Active' else 'Retired' end where rule_version_id in ('A-ASM-1.0', 'A-ASM-9.9')`));
      await scheduleReassessment(db, ids.users.admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today(), targetEnd: plusDays(5) });
      const re = await takeAssessment(db, user, profile('A')); // reassessment on A-ASM-9.9
      const a = await analysisOf(re.instanceId);
      expect(a.ca).toMatchObject({ comparison_status: 'Cross-Version Comparison - Review Required', hgi_change: null });
      expect(a.rows).toHaveLength(0);
    } finally {
      await db.system((tx) => tx.query(`update rule_version set status = case rule_version_id when 'A-ASM-1.0' then 'Active' else 'Retired' end where rule_version_id in ('A-ASM-1.0', 'A-ASM-9.9')`));
    }
  });

  it('TST-REA-002: correcting the baseline keeps the audit trail and refreshes the change analysis (superseded, not overwritten)', async () => {
    const r = await baselineAndReassess('ReaCorrect', 'B', 'A');
    const before = await analysisOf(r.reId);
    expect(before.ca.hgi_change).toBe('20');
    await correctResponse(db, ids.users.admin, { instanceId: r.baseId, itemCode: 'Q1', answer: '4', reason: 'Data-entry error at baseline' });
    const after = await analysisOf(r.reId);
    expect(after.ca.hgi_change).toBe('16'); // baseline 84.0 -> current 100.0
    const all = (await db.system((tx) => tx.query<{ n: number }>('select count(*)::int n from change_analysis where current_instance_id = $1', [r.reId]))).rows[0].n;
    expect(all).toBe(2); // earlier analysis kept as superseded
  });

  it('TST-CHG-008 (Doc 4): completing an action item never changes a finding state', async () => {
    const r = await baselineAndReassess('ReaAction', 'B', 'B', { releaseBaseline: true });
    const before = (await analysisOf(r.reId)).states;
    const item = (await athleteResult(db, r.user))!.actionItems[0];
    await completeActionItem(db, r.user, item.action_item_id);
    expect((await analysisOf(r.reId)).states).toEqual(before);
    const h = await athleteHistory(db, ids.users.admin, r.pid);
    expect(h!.interventions.some((i) => i.status === 'Completed / Implemented')).toBe(true);
  });
});

describe('Role-based behavior for history and change', () => {
  it('the athlete sees the change since baseline only after WeCanH2O releases the reassessment', async () => {
    const r = await baselineAndReassess('ReaRelease', 'B', 'A', { releaseBaseline: true });
    const mine = await athleteHistory(db, r.user, r.pid);
    expect(mine!.analyses).toHaveLength(0); // not released yet
    await release(r.reId);
    const after = await athleteHistory(db, r.user, r.pid);
    expect(after!.analyses).toHaveLength(1);
    expect(after!.findingChanges.length).toBeGreaterThan(0);
    expect(after!.duplicates).toHaveLength(0); // admin-only sections stay empty
    expect(after!.grants).toHaveLength(0);
  });

  it('search: admin sees own institutions, trainer only assigned athletes, coach and leader nobody, other institution nothing', async () => {
    const admin = await searchAthletes(db, ids.users.admin, {});
    expect(admin.length).toBeGreaterThan(5);
    expect(admin.every((r) => r.institution !== 'Lakeview College (Fictional)')).toBe(true);
    const trainer = await searchAthletes(db, ids.users.health, {});
    expect(trainer.every((r) => (r.teams ?? '').includes('Track & Field'))).toBe(true);
    expect(trainer.some((r) => r.email === 'riley.hayes@northbridge.test')).toBe(false); // Soccer
    expect(await searchAthletes(db, ids.users.coach, {})).toHaveLength(0);
    expect(await searchAthletes(db, ids.users.leader, {})).toHaveLength(0);
    expect((await searchAthletes(db, ids.users.adminB, {})).every((r) => r.institution === 'Lakeview College (Fictional)')).toBe(true);
    expect(await athleteHistory(db, ids.users.coach, await participantOf(ids.users.athlete1))).toBeNull();
  });

  it('search filters: text, safety flag, band', async () => {
    const byName = await searchAthletes(db, ids.users.admin, { q: 'riley' });
    expect(byName.map((r) => r.email)).toEqual(['riley.hayes@northbridge.test']);
    const byCode = await searchAthletes(db, ids.users.admin, { q: 'ATH-000001' });
    expect(byCode[0].email).toBe('jordan.rivers@northbridge.test');
    const safety = await searchAthletes(db, ids.users.admin, { safety: 'yes' });
    expect(safety.length).toBeGreaterThan(0);
    expect(safety.every((r) => r.safety > 0)).toBe(true);
    const mild = await searchAthletes(db, ids.users.admin, { band: 'Mild Gap' });
    expect(mild.every((r) => r.latest_band === 'Mild Gap')).toBe(true);
  });

  it('explicit, time-limited access lets a coach see one athlete; revoking ends it; only admins can grant', async () => {
    const pid = await participantOf(ids.users.athlete2);
    const sees = async () => (await db.asUser(ids.users.coach, (tx) => tx.query('select 1 from athlete_profile where participant_id = $1', [pid]))).rows.length;
    expect(await sees()).toBe(0);
    await expect(grantAccess(db, ids.users.coach, pid, ids.users.coach, plusDays(7), 'self')).rejects.toThrow(/permission/);
    await expect(grantAccess(db, ids.users.admin, pid, ids.users.coach, plusDays(7), ' ')).rejects.toThrow(/reason/);
    await grantAccess(db, ids.users.admin, pid, ids.users.coach, plusDays(7), 'Approved follow-up meeting');
    expect(await sees()).toBe(1);
    expect((await searchAthletes(db, ids.users.coach, {})).map((r) => r.participant_id)).toEqual([pid]);
    const g = (await athleteHistory(db, ids.users.admin, pid))!.grants[0];
    await revokeAccess(db, ids.users.admin, g.grant_id);
    expect(await sees()).toBe(0);
    expect((await athleteHistory(db, ids.users.admin, pid))!.grants[0].revoked_at).not.toBeNull();
  });
});

describe('Administration: transfers and duplicates', () => {
  it('TST-REA-005: moving Team A -> Team B keeps the earlier assessment with Team A', async () => {
    const user = await newAthlete(db, ids.users.admin, ids.teams.trackField, 'Transfer');
    const pid = await participantOf(user);
    // The athlete joined Track & Field earlier in the season.
    await db.system((tx) => tx.query('update athlete_team_affiliation set effective_start = current_date - 60 where participant_id = $1', [pid]));
    const base = await takeAssessment(db, user, profile('A'));
    await expect(transferAthlete(db, ids.users.coach, pid, ids.teams.soccer, plusDays(1))).rejects.toThrow(/permission/);
    await expect(transferAthlete(db, ids.users.admin, pid, ids.teams.lakeviewBasketball, plusDays(1))).rejects.toThrow(/does not belong/);
    await transferAthlete(db, ids.users.admin, pid, ids.teams.soccer, today());
    const h = (await athleteHistory(db, ids.users.admin, pid))!;
    expect(h.instances.find((i) => i.instance_id === base.instanceId)?.team).toBe('Track & Field');
    expect(h.affiliations.map((a) => [a.team, a.effective_end == null])).toEqual([['Track & Field', false], ['Soccer', true]]);
    // The Track & Field trainer no longer sees the athlete after the move.
    expect((await searchAthletes(db, ids.users.health, {})).some((r) => r.participant_id === pid)).toBe(false);
  });

  it('LFC-031/032: linking a duplicate keeps every record and history; the newer sign-in is turned off', async () => {
    await uploadRoster(db, ids.users.admin, ids.teams.soccer, 'Dup,Person,dup.one@northbridge.test\nDup,Person,dup.two@northbridge.test');
    const first = await registerAthlete(db, 'dup.one@northbridge.test', '2003-03-03', 'Same');
    const second = await registerAthlete(db, 'dup.two@northbridge.test', '2003-03-03', 'Same');
    await takeAssessment(db, second, profile('A'));
    const [p1, p2] = [await participantOf(first), await participantOf(second)];
    const review = (await db.system((tx) => tx.query<{ duplicate_review_id: string }>(
      'select duplicate_review_id from duplicate_review where participant_id = $1 and candidate_participant_id = $2', [p2, p1]))).rows[0];
    await expect(resolveDuplicate(db, ids.users.admin, review.duplicate_review_id, 'link', '')).rejects.toThrow(/reason/);
    await resolveDuplicate(db, ids.users.admin, review.duplicate_review_id, 'link', 'Same athlete, two emails');
    const h = (await athleteHistory(db, ids.users.admin, p1))!;
    expect(h.instances).toHaveLength(1); // the linked record's assessment shows on the surviving record
    expect((await login(db, 'dup.two@northbridge.test', DEV_PASSWORD)).ok).toBe(false);
    expect((await searchAthletes(db, ids.users.admin, { q: 'dup.two' }))).toHaveLength(0);
    const kept = (await db.system((tx) => tx.query<{ status: string; merged_into_id: string }>('select status, merged_into_id from participant where participant_id = $1', [p2]))).rows[0];
    expect(kept).toEqual({ status: 'Merged', merged_into_id: p1 });
    await expect(resolveDuplicate(db, ids.users.admin, review.duplicate_review_id, 'different', 'again')).rejects.toThrow(/already/);
  });
});

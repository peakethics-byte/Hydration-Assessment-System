// End-to-end tests through the database, row-level security and services (fictional data only).
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '@/src/server/db';
import { seedDemo, registerAthlete, type SeedIds, DEV_PASSWORD } from '@/src/server/seed';
import { completeRegistration, registrationInfo, sendInvitations, uploadRoster, websiteSignup } from '@/src/server/roster';
import { addStaff, completeSetup, decideRequest, endStaffRole, listRequests, requestAccess, setupInfo } from '@/src/server/accounts';
import { userList } from '@/src/server/admin';
import { acknowledge, ackStatus, athleteResult, completeActionItem, draftMaintenance, openAssessment, reopenDraft, saveDraft, submitAssessment } from '@/src/server/assessment';
import { correctResponse, correctionHistory } from '@/src/server/corrections';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail, reviewQueue } from '@/src/server/review';
import { login, sessionUser } from '@/src/server/auth';
import { programPeriods } from '@/src/server/institution';
import { PROFILES } from '@/src/testing/fixtures';
import { storedResult, takeAssessment } from '@/src/testing/harness';

let db: Db;
let ids: SeedIds;
const profile = (id: string) => PROFILES.find((p) => p.id === id)!;
const linkFor = async (email: string) =>
  (await db.system((tx) => tx.query<{ link: string }>('select link from email_outbox where to_email = $1 order by email_id desc limit 1', [email]))).rows[0]?.link;

beforeAll(async () => {
  db = await openDb();
  ids = await seedDemo(db);
});

describe('Secure records and sign-in', () => {
  it('signs in with email and password; wrong password is refused and logged', async () => {
    const ok = await login(db, 'admin@wecanh2o.test', DEV_PASSWORD);
    expect(ok.ok).toBe(true);
    const u = await sessionUser(db, ok.ok ? ok.sessionToken : undefined);
    expect(u?.roles.map((r) => r.role)).toContain('program_admin');
    expect((await login(db, 'admin@wecanh2o.test', 'wrong-password-1')).ok).toBe(false);
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) await login(db, 'coach@northbridge.test', 'wrong-password-1');
    const r = await login(db, 'coach@northbridge.test', DEV_PASSWORD);
    expect(r.ok).toBe(false);
    await db.system((tx) => tx.query(`update app_user set failed_logins = 0, locked_until = null where email = 'coach@northbridge.test'`));
  });

  it('audit log is append-only, even for the database owner', async () => {
    await expect(db.system((tx) => tx.query('update audit_event set action = $1', ['x']))).rejects.toThrow(/append-only/);
    await expect(db.system((tx) => tx.query('delete from audit_event'))).rejects.toThrow(/append-only/);
  });

  it('TST-DAT-001: Program Start 9/15/2026 generates the exact periods', () => {
    const p = programPeriods('2026-09-15');
    expect(p.quarters.map((q) => [q.start, q.end])).toEqual([
      ['2026-09-15', '2026-12-14'], ['2026-12-15', '2027-03-14'], ['2027-03-15', '2027-06-14'], ['2027-06-15', '2027-09-14']]);
    expect([p.annual.start, p.annual.end]).toEqual(['2026-09-15', '2027-09-14']);
  });
});

describe('Athlete sign-up: both ways start from the team list', () => {
  it('Way 1: email not on a team list cannot sign up and is told to contact the coach', async () => {
    const r = await websiteSignup(db, { firstName: 'Not', lastName: 'Listed', email: 'stranger@example.test' });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/contact your coach/i);
  });

  it('Way 1: listed email gets a link, registers and is placed on the right team', async () => {
    const r = await websiteSignup(db, { firstName: 'Avery', lastName: 'Brooks', email: 'Avery.Brooks@northbridge.test' });
    expect(r.ok).toBe(true);
    const token = (await linkFor('avery.brooks@northbridge.test'))!.split('/register/')[1];
    const done = await completeRegistration(db, token, { password: DEV_PASSWORD, dateOfBirth: '2005-02-02', mothersMaidenName: 'Example' });
    expect(done.ok).toBe(true);
    const team = (await db.system((tx) => tx.query<{ name: string }>(
      `select t.name from athlete_team_affiliation a join team t using (team_id) where a.participant_id = $1`, [done.ok ? done.participantId : '']))).rows;
    expect(team.map((t) => t.name)).toEqual(['Track & Field']);
    // Link cannot be used twice.
    expect((await completeRegistration(db, token, { password: DEV_PASSWORD, dateOfBirth: '2005-02-02', mothersMaidenName: 'Example' })).ok).toBe(false);
  });

  it('Way 2: invitation emails go to every listed athlete not yet invited', async () => {
    const r = await sendInvitations(db, ids.users.admin, ids.teams.trackField);
    expect(r.sent).toBe(2); // Casey and Taylor (Jordan and Avery already registered)
    expect(await linkFor('casey.morgan@northbridge.test')).toMatch(/\/register\//);
  });

  it('only a Program Administrator of that institution can send invitations', async () => {
    await expect(sendInvitations(db, ids.users.adminB, ids.teams.trackField)).rejects.toThrow(/permission/);
    await expect(sendInvitations(db, ids.users.tech, ids.teams.trackField)).rejects.toThrow(/permission/);
  });

  it('stores date of birth and only a hash of the mother\'s maiden name; system Athlete ID is the key', async () => {
    const row = (await db.system((tx) => tx.query<{ athlete_code: string; date_of_birth: string; mothers_maiden_name_hash: string }>(
      `select p.athlete_code, ap.date_of_birth::text, ap.mothers_maiden_name_hash from athlete_profile ap join participant p using (participant_id)
       where ap.email = 'avery.brooks@northbridge.test'`))).rows[0];
    expect(row.athlete_code).toMatch(/^ATH-\d{6}$/);
    expect(row.date_of_birth).toBe('2005-02-02');
    expect(row.mothers_maiden_name_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.mothers_maiden_name_hash.toLowerCase()).not.toContain('example');
  });

  it('TST-LFC-005: a matching identity is queued for review, never merged automatically', async () => {
    await uploadRoster(db, ids.users.admin, ids.teams.soccer, 'Avery,Brooks,avery.b.second@northbridge.test');
    await registerAthlete(db, 'avery.b.second@northbridge.test', '2005-02-02', 'Example');
    const dups = (await db.system((tx) => tx.query<{ reason: string }>('select reason from duplicate_review'))).rows;
    expect(dups.map((d) => d.reason)).toContain("Same name, date of birth and mother's maiden name");
    const n = (await db.system((tx) => tx.query<{ n: number }>(`select count(*)::int n from athlete_profile where first_name = 'Avery'`))).rows[0].n;
    expect(n).toBe(2);
  });
});

describe('Electronic assessment, validation, saving and lock', () => {
  let instanceId: string;

  it('saves a draft with a 14-day window', async () => {
    const inst = await openAssessment(db, ids.users.athlete1);
    instanceId = inst.instance_id;
    await saveDraft(db, ids.users.athlete1, instanceId, { Q1: '4', Q2: '3' });
    const row = (await db.system((tx) => tx.query<{ status: string; days: number }>(
      `select status, extract(day from draft_expires_at - started_at)::int as days from assessment_instance where instance_id = $1`, [instanceId]))).rows[0];
    expect(row).toEqual({ status: 'In Progress', days: 14 });
  });

  it('TST-LFC-004 / Profile J: missing required item -> Assessment Incomplete, no HGI, not locked', async () => {
    const r = await takeAssessment(db, ids.users.athlete1, profile('J').answers);
    expect(r.result.ok).toBe(false);
    if (!r.result.ok) {
      expect(r.result.statusLabel).toBe('Assessment Incomplete - HGI Not Calculated');
      expect(r.result.missingItems).toEqual(['Q6']);
    }
    const s = await storedResult(db, r.instanceId);
    expect(s.hgi.status).toBe('Incomplete');
    expect(s.hgi.hgi_display).toBeNull();
    expect(s.inst.status).toBe('In Progress');
    expect(s.inst.locked_at).toBeNull();
  });

  it('completing the missing answer scores the assessment and locks it (TST-LFC-001)', async () => {
    const r = await takeAssessment(db, ids.users.athlete1, profile('H').answers);
    expect(r.instanceId).toBe(instanceId);
    expect(r.result.ok).toBe(true);
    const s = await storedResult(db, instanceId);
    expect(s.inst.status).toBe('Complete / Scored');
    expect(s.hgi).toMatchObject({ hgi_display: '62.5', band: 'Moderate Gap', status: 'Calculated' });
    expect([s.inst.asm_version_id, s.inst.scr_version_id, s.inst.hga_version_id, s.inst.rec_version_id])
      .toEqual(['A-ASM-1.0', 'A-SCR-1.0', 'A-HGA-1.0', 'A-REC-1.0']);
    await expect(saveDraft(db, ids.users.athlete1, instanceId, { Q1: '0' })).rejects.toThrow(/locked/);
    // The database itself refuses the edit, even bypassing the service.
    const direct = await db.asUser(ids.users.athlete1, (tx) =>
      tx.query(`update item_response set option_code = '0' where instance_id = $1 and item_code = 'Q1'`, [instanceId]));
    expect(direct.affectedRows ?? 0).toBe(0);
  });

  it('TST-IHS-007: athlete sees nothing before approval and release', async () => {
    expect(await athleteResult(db, ids.users.athlete1)).toBeNull();
    const rows = await db.asUser(ids.users.athlete1, (tx) => tx.query('select * from hgi_result where instance_id = $1', [instanceId]));
    expect(rows.rows).toHaveLength(0);
  });

  it('O-05: reminder before the draft window closes; on expiry the answers are kept and an admin can reopen', async () => {
    const inst = await openAssessment(db, ids.users.athlete2);
    await saveDraft(db, ids.users.athlete2, inst.instance_id, { Q1: '4' });
    await db.system((tx) => tx.query(`update assessment_instance set draft_expires_at = now() + interval '2 days' where instance_id = $1`, [inst.instance_id]));
    expect((await draftMaintenance(db)).reminded).toBe(1);
    expect((await draftMaintenance(db)).reminded).toBe(0); // only once
    const reminder = (await db.system((tx) => tx.query<{ subject: string }>(
      `select subject from email_outbox where to_email = 'riley.hayes@northbridge.test' order by email_id desc limit 1`))).rows[0];
    expect(reminder.subject).toMatch(/Reminder/);

    await db.system((tx) => tx.query(`update assessment_instance set draft_expires_at = now() - interval '1 minute' where instance_id = $1`, [inst.instance_id]));
    expect((await draftMaintenance(db)).expired).toBe(1);
    const kept = (await db.system((tx) => tx.query<{ n: number }>(`select count(*)::int n from item_response where instance_id = $1 and response_state <> 'blank'`, [inst.instance_id]))).rows[0].n;
    expect(kept).toBe(1); // no automatic permanent deletion
    await expect(saveDraft(db, ids.users.athlete2, inst.instance_id, { Q2: '4' })).rejects.toThrow(); // expired draft is closed

    await expect(reopenDraft(db, ids.users.coach, inst.instance_id)).rejects.toThrow(/permission/);
    await reopenDraft(db, ids.users.admin, inst.instance_id);
    const again = await openAssessment(db, ids.users.athlete2);
    expect(again.instance_id).toBe(inst.instance_id);
    expect(again.status).toBe('In Progress');
    await saveDraft(db, ids.users.athlete2, inst.instance_id, { Q2: '4' });
  });
});

describe('Review, approval and release (IHS)', () => {
  let instanceId: string;
  beforeAll(async () => {
    instanceId = (await reviewQueue(db, ids.users.admin)).find((r) => r.athlete_code)!.instance_id;
  });

  it('queue shows safety records first and only to the Program Administrator of that institution', async () => {
    const q = await reviewQueue(db, ids.users.admin);
    expect(q[0].safety).toBeGreaterThan(0);
    expect(await reviewQueue(db, ids.users.adminB)).toHaveLength(0); // other institution (TST-PRV-001)
    expect(await reviewQueue(db, ids.users.coach)).toHaveLength(0);
    expect(await reviewQueue(db, ids.users.tech)).toHaveLength(0);
  });

  it('TST-ROL-005: technical admin cannot approve; release before decisions is refused', async () => {
    const d = (await reviewDetail(db, ids.users.admin, instanceId))!;
    await expect(decideRecommendation(db, ids.users.tech, { recId: d.recommendations[0].rec_id, decision: 'approve' })).rejects.toThrow(/permission/);
    await expect(releaseResults(db, ids.users.admin, instanceId)).rejects.toThrow(/Reviewed/);
    await markReviewed(db, ids.users.admin, instanceId);
    await expect(releaseResults(db, ids.users.admin, instanceId)).rejects.toThrow(/need a decision/);
  });

  it('TST-IHS-008: Suggested -> Reviewed -> Approved -> Assigned / Delivered; athlete then sees approved content only', async () => {
    const d = (await reviewDetail(db, ids.users.admin, instanceId))!;
    expect(d.recommendations[0].pathway).toBe('E'); // safety first
    for (const r of d.recommendations) {
      if (r.rule_id === 'HGA-C1') await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'not_approve', note: 'Covered by X03' });
      else if (r.rule_id === 'HGA-X03') await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'approve', pathway: 'D' });
      else await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'approve' });
    }
    await releaseResults(db, ids.users.admin, instanceId);
    const s = await storedResult(db, instanceId);
    expect(s.inst.status).toBe('Released');
    expect(s.recs.find((r) => r.rule_id === 'HGA-X03')).toMatchObject({ pathway: 'D', status: 'Assigned / Delivered' });
    expect(s.recs.find((r) => r.rule_id === 'HGA-C1')?.status).toBe('Not Approved');

    const res = (await athleteResult(db, ids.users.athlete1))!;
    expect(res.hgiDisplay).toBe('62.5');
    expect(res.band).toBe('Moderate Gap');
    expect(res.priorities[0].isSafety).toBe(true);
    expect(res.priorities.map((p) => p.title)).not.toContain('Daily / circadian hydration routine gap'); // not approved
    expect(res.actionItems.every((a) => a.athlete_text === 'WeCanH2O')).toBe(true);
    const json = JSON.stringify(res);
    expect(json).not.toMatch(/HGA-|A-HGA|A-SCR|points|weight/i); // no rule IDs, weights or formulas
  });

  it('TST-IHS-009: completing an action item does not change any finding', async () => {
    const res = (await athleteResult(db, ids.users.athlete1))!;
    const before = await storedResult(db, instanceId);
    await completeActionItem(db, ids.users.athlete1, res.actionItems[0].action_item_id);
    const after = await storedResult(db, instanceId);
    expect(after.findings).toEqual(before.findings);
  });
});

describe('Roles, privacy and institutional segregation (Document #8 Section 23)', () => {
  const individual = ['athlete_profile', 'item_response', 'hgi_result', 'category_score', 'hga_finding', 'recommendation'];
  const count = (userId: string, table: string) =>
    db.asUser(userId, (tx) => tx.query<{ n: number }>(`select count(*)::int n from ${table}`)).then((r) => r.rows[0].n);

  it('TST-ROL-001: Athlete A cannot open Athlete B record', async () => {
    const other = (await db.system((tx) => tx.query<{ instance_id: string }>(
      `select i.instance_id from assessment_instance i join participant p using (participant_id) where p.user_id = $1`, [ids.users.athlete2]))).rows[0];
    const r = await db.asUser(ids.users.athlete1, (tx) => tx.query('select * from assessment_instance where instance_id = $1', [other.instance_id]));
    expect(r.rows).toHaveLength(0);
    expect(await count(ids.users.athlete1, 'athlete_profile')).toBe(1); // own only
  });

  it('TST-ROL-002 / ROL-004: coach and institution leader have no individual access by default', async () => {
    for (const t of individual) {
      expect(await count(ids.users.coach, t), `coach ${t}`).toBe(0);
      expect(await count(ids.users.leader, t), `leader ${t}`).toBe(0);
    }
  });

  it('health support sees only assigned athletes (Track & Field), including safety detail', async () => {
    const seen = (await db.asUser(ids.users.health, (tx) => tx.query<{ email: string }>('select email from athlete_profile'))).rows.map((r) => r.email);
    expect(seen).toContain('jordan.rivers@northbridge.test');
    expect(seen).not.toContain('riley.hayes@northbridge.test'); // Soccer
    expect(await count(ids.users.health, 'hga_finding')).toBeGreaterThan(0);
  });

  it('TST-PRV-001: Institution B cannot read any Institution A record', async () => {
    for (const t of [...individual, 'team', 'roster_entry', 'audit_event']) {
      const rows = await db.asUser(ids.users.adminB, (tx) => tx.query<{ tenant_id: string }>(`select tenant_id from ${t}`));
      expect(rows.rows.every((r) => r.tenant_id === ids.tenantB), t).toBe(true);
    }
  });

  it('technical admin has no business data access', async () => {
    for (const t of individual) expect(await count(ids.users.tech, t), t).toBe(0);
  });

  it('application role cannot read passwords, sessions, sign-up tokens or the email outbox', async () => {
    for (const sql of ['select password_hash from app_user', 'select * from user_session', 'select * from signup_token', 'select * from email_outbox']) {
      await expect(db.asUser(ids.users.admin, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('Recommendation release gate in the database', () => {
  it('a recommendation cannot be Assigned / Delivered without an approver, even by the owner', async () => {
    const athlete = ids.users.athleteB;
    const r = await takeAssessment(db, athlete, profile('B').answers);
    expect(r.result.ok).toBe(true);
    await expect(db.system((tx) => tx.query(
      `update recommendation set status = 'Assigned / Delivered', released_at = now() where instance_id = $1`, [r.instanceId]))).rejects.toThrow(/check constraint/);
  });
});

describe('Governed correction and revalidation (R-09, LFC-014..016, AUD-101)', () => {
  let athlete: string;
  let instanceId: string;
  beforeAll(async () => {
    await uploadRoster(db, ids.users.admin, ids.teams.trackField, 'Corr,Case,corr.case@northbridge.test');
    athlete = await registerAthlete(db, 'corr.case@northbridge.test', '2003-03-03', 'Sample');
    instanceId = (await takeAssessment(db, athlete, profile('B').answers)).instanceId; // HGI 80.0
    await markReviewed(db, ids.users.admin, instanceId);
    for (const r of (await reviewDetail(db, ids.users.admin, instanceId))!.recommendations) {
      await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'approve' });
    }
    await releaseResults(db, ids.users.admin, instanceId);
  });

  it('only a Program Administrator can correct, with a reason, and not to a blank required answer', async () => {
    await expect(correctResponse(db, ids.users.tech, { instanceId, itemCode: 'Q1', answer: '4', reason: 'x' })).rejects.toThrow(/permission/);
    await expect(correctResponse(db, ids.users.admin, { instanceId, itemCode: 'Q1', answer: '4', reason: ' ' })).rejects.toThrow(/reason/);
    await expect(correctResponse(db, ids.users.admin, { instanceId, itemCode: 'Q1', answer: null, reason: 'x' })).rejects.toThrow(/required/);
    await expect(correctResponse(db, ids.users.athlete1, { instanceId, itemCode: 'Q1', answer: '4', reason: 'x' })).rejects.toThrow(/permission/);
  });

  it('correction keeps the original, snapshots the old result, rescores and supersedes the old IHS', async () => {
    const r = await correctResponse(db, ids.users.admin, { instanceId, itemCode: 'Q1', answer: '4', reason: 'Athlete reported a data-entry error' });
    expect(r).toEqual({ ok: true, status: 'Revalidated' });
    const s = await storedResult(db, instanceId);
    expect(s.inst.status).toBe('Revalidated');
    expect(s.hgi.hgi_display).toBe('84.0'); // C1 = 4 -> 4 + 15 + 15 + 15 + 10 + 10 + 15
    expect(s.findings.filter((f) => f.finding_type !== 'strength').map((f) => f.rule_id)).toEqual(['HGA-X03', 'HGA-C1']); // C1 20% still low
    expect(s.recs.every((x) => x.status === 'Suggested by Rules Engine')).toBe(true);

    const hist = await correctionHistory(db, ids.users.admin, instanceId);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ item_code: 'Q1', original_option_code: '0', corrected_option_code: '4', reason: 'Athlete reported a data-entry error' });
    const rev = (await db.system((tx) => tx.query<{ status_before: string; snapshot: { hgi: { hgi_display: string }[]; recommendations: { status: string }[] } }>(
      'select status_before, snapshot from result_revision where instance_id = $1', [instanceId]))).rows;
    expect(rev).toHaveLength(1);
    expect(rev[0].status_before).toBe('Released');
    expect(Number(rev[0].snapshot.hgi[0].hgi_display)).toBe(80);
    expect(rev[0].snapshot.recommendations.every((x) => x.status === 'Assigned / Delivered')).toBe(true);

    const ihs = (await db.system((tx) => tx.query<{ superseded_at: string | null; supersedes_id: string | null }>(
      'select superseded_at, supersedes_id from ihs where instance_id = $1 order by superseded_at nulls last', [instanceId]))).rows;
    expect(ihs).toHaveLength(2);
    expect(ihs[0].superseded_at).not.toBeNull(); // earlier IHS kept
    expect(ihs[1].supersedes_id).not.toBeNull(); // new IHS points to it
    const oldItems = (await db.system((tx) => tx.query<{ n: number }>(
      `select count(*)::int n from action_item a join recommendation r using (rec_id) where r.instance_id = $1 and a.superseded_at is not null`, [instanceId]))).rows[0].n;
    expect(oldItems).toBeGreaterThan(0);
  });

  it('corrected record is hidden from the athlete until reviewed and released again', async () => {
    expect(await athleteResult(db, athlete)).toBeNull();
    await markReviewed(db, ids.users.admin, instanceId);
    for (const r of (await reviewDetail(db, ids.users.admin, instanceId))!.recommendations) {
      await decideRecommendation(db, ids.users.admin, { recId: r.rec_id, decision: 'approve' });
    }
    await releaseResults(db, ids.users.admin, instanceId);
    const res = (await athleteResult(db, athlete))!;
    expect(res.hgiDisplay).toBe('84.0');
    expect(res.actionItems).toHaveLength(2); // only the current IHS, not the superseded one
  });

  it('correction and revision records are append-only', async () => {
    await expect(db.system((tx) => tx.query('update response_correction set reason = $1', ['x']))).rejects.toThrow(/append-only/);
    await expect(db.system((tx) => tx.query('delete from result_revision'))).rejects.toThrow(/append-only/);
  });

  it('a correction that changes nothing is refused', async () => {
    await expect(correctResponse(db, ids.users.admin, { instanceId, itemCode: 'Q1', answer: '4', reason: 'again' })).rejects.toThrow(/same/);
  });
});

describe('Acknowledgment capability (R-41, PRV-025..027, LFC-033..036)', () => {
  it('when required, the athlete must acknowledge the current version before answering; the version is recorded', async () => {
    await uploadRoster(db, ids.users.admin, ids.teams.soccer, 'Ack,Case,ack.case@northbridge.test');
    const athlete = await registerAthlete(db, 'ack.case@northbridge.test', '2004-04-04', 'Ack');
    await db.system((tx) => tx.query('update privacy_config set ack_required = true where tenant_id = $1', [ids.tenantA]));
    try {
      const st = await ackStatus(db, athlete);
      expect(st).toMatchObject({ required: true, acknowledged: false, documentVersionId: 'ACK-PENDING-1' });
      const inst = await openAssessment(db, athlete);
      await expect(saveDraft(db, athlete, inst.instance_id, { Q1: '4' })).rejects.toThrow(/acknowledge/);
      await expect(submitAssessment(db, athlete, inst.instance_id)).rejects.toThrow(/acknowledge/);
      await acknowledge(db, athlete, 'ACK-PENDING-1');
      expect(await ackStatus(db, athlete)).toMatchObject({ acknowledged: true });
      await saveDraft(db, athlete, inst.instance_id, { Q1: '4' });
      const rec = (await db.system((tx) => tx.query<{ document_version_id: string; program_year_id: string | null }>(
        `select a.document_version_id, a.program_year_id from ack_record a join participant p using (participant_id) where p.user_id = $1`, [athlete]))).rows;
      expect(rec).toHaveLength(1);
      expect(rec[0].program_year_id).not.toBeNull();
    } finally {
      await db.system((tx) => tx.query('update privacy_config set ack_required = false where tenant_id = $1', [ids.tenantA]));
    }
  });
});

describe('Safety routing (IHS-008)', () => {
  it('a safety finding alerts the Program Administrator and assigned health support, without symptom detail', async () => {
    await uploadRoster(db, ids.users.admin, ids.teams.trackField, 'Safe,Case,safe.case@northbridge.test');
    const athlete = await registerAthlete(db, 'safe.case@northbridge.test', '2004-05-05', 'Safe');
    await takeAssessment(db, athlete, profile('E').answers);
    const mail = (await db.system((tx) => tx.query<{ to_email: string; body: string }>(
      `select to_email, body from email_outbox where subject = 'Priority review: safety finding'`))).rows;
    const to = mail.map((m) => m.to_email);
    expect(to).toContain('admin@wecanh2o.test');
    expect(to).toContain('trainer@northbridge.test');
    expect(to).not.toContain('coach@northbridge.test');
    expect(mail.every((m) => !/dizziness|symptom detail:/i.test(m.body))).toBe(true);
  });
});

describe('Users page (read only)', () => {
  it('a Program Administrator sees only the people in their own institutions; others see nobody', async () => {
    const { userList } = await import('@/src/server/admin');
    const mine = await userList(db, ids.users.admin);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => ['Northbridge State University (Fictional)', 'Individual Users (WeCanH2O)'].includes(r.institution))).toBe(true);
    expect(mine.map((r) => r.email)).toEqual(expect.arrayContaining(['coach@northbridge.test', 'jordan.rivers@northbridge.test']));
    expect(mine.map((r) => r.email)).not.toContain('quinn.parker@lakeview.test');
    expect(mine.find((r) => r.email === 'jordan.rivers@northbridge.test')).toMatchObject({ role: 'athlete', teams: 'Track & Field' });
    const other = await userList(db, ids.users.adminB);
    expect(other.map((r) => r.email)).not.toContain('coach@northbridge.test');
    for (const k of ['coach', 'leader', 'health', 'tech', 'athlete1'] as const) expect(await userList(db, ids.users[k])).toHaveLength(0);
  });
});

describe('Staff accounts (added by the Program Administrator)', () => {
  const setupToken = async (email: string) => {
    const link = (await db.system((tx) => tx.query<{ link: string }>(
      'select link from email_outbox where to_email = $1 order by email_id desc limit 1', [email]))).rows[0]?.link;
    return link?.split('/account/setup/')[1];
  };

  it('adds a coach for one team; the coach sets a password from the emailed link and can sign in', async () => {
    const r = await addStaff(db, ids.users.admin, { tenantId: ids.tenantA, teamId: ids.teams.soccer, name: 'Soccer Coach', email: 'soccer.coach@northbridge.test', role: 'coach' });
    expect(r.newAccount).toBe(true);
    expect((await login(db, 'soccer.coach@northbridge.test', DEV_PASSWORD)).ok).toBe(false); // no password yet
    const token = (await setupToken('soccer.coach@northbridge.test'))!;
    expect(await setupInfo(db, token)).toMatchObject({ ok: true, name: 'Soccer Coach' });
    expect((await completeSetup(db, token, 'short')).ok).toBe(false);
    expect((await completeSetup(db, token, 'Coach-Pass-2026')).ok).toBe(true);
    expect((await completeSetup(db, token, 'Coach-Pass-2026')).ok).toBe(false); // one-time link
    const signIn = await login(db, 'soccer.coach@northbridge.test', 'Coach-Pass-2026');
    expect(signIn.ok).toBe(true);
    const u = await sessionUser(db, signIn.ok ? signIn.sessionToken : undefined);
    expect(u?.roles).toEqual([expect.objectContaining({ role: 'coach', scopeType: 'team', scopeId: ids.teams.soccer })]);
  });

  it('enforces the rules: admin of that institution only, coach needs a team, no athlete emails, no duplicates', async () => {
    await expect(addStaff(db, ids.users.adminB, { tenantId: ids.tenantA, name: 'X', email: 'x1@northbridge.test', role: 'inst_leader' })).rejects.toThrow(/permission/);
    await expect(addStaff(db, ids.users.coach, { tenantId: ids.tenantA, name: 'X', email: 'x2@northbridge.test', role: 'inst_leader' })).rejects.toThrow(/permission/);
    await expect(addStaff(db, ids.users.admin, { tenantId: ids.tenantA, name: 'X', email: 'x3@northbridge.test', role: 'coach' })).rejects.toThrow(/team/);
    await expect(addStaff(db, ids.users.admin, { tenantId: ids.tenantA, teamId: ids.teams.lakeviewBasketball, name: 'X', email: 'x4@northbridge.test', role: 'health_support' })).rejects.toThrow(/does not belong/);
    await expect(addStaff(db, ids.users.admin, { tenantId: ids.tenantA, name: 'X', email: 'jordan.rivers@northbridge.test', role: 'inst_leader' })).rejects.toThrow(/athlete/);
    await expect(addStaff(db, ids.users.admin, { tenantId: ids.tenantA, teamId: ids.teams.trackField, name: 'X', email: 'coach@northbridge.test', role: 'coach' })).rejects.toThrow(/already/);
  });

  it('ending a role removes access but keeps the history; an admin cannot end their own admin access', async () => {
    await addStaff(db, ids.users.admin, { tenantId: ids.tenantA, name: 'Temp Leader', email: 'temp.leader@northbridge.test', role: 'inst_leader' });
    const row = (await userList(db, ids.users.admin)).find((r) => r.email === 'temp.leader@northbridge.test')!;
    expect(row.setup_pending).toBe(true);
    await endStaffRole(db, ids.users.admin, row.role_assignment_id);
    expect((await userList(db, ids.users.admin)).some((r) => r.email === 'temp.leader@northbridge.test')).toBe(false);
    const kept = (await db.system((tx) => tx.query('select 1 from role_assignment where role_assignment_id = $1 and valid_to is not null', [row.role_assignment_id]))).rows;
    expect(kept).toHaveLength(1);
    const own = (await userList(db, ids.users.admin)).find((r) => r.user_id === ids.users.admin && r.role === 'program_admin')!;
    await expect(endStaffRole(db, ids.users.admin, own.role_assignment_id)).rejects.toThrow(/own/);
  });
});

describe('Individual users (not on a college team list)', () => {
  it('request -> WeCanH2O approves -> same registration details -> private results, no team', async () => {
    expect((await requestAccess(db, { firstName: 'Indy', lastName: 'Vidual', email: 'indy@example.test' })).ok).toBe(true);
    expect((await requestAccess(db, { firstName: 'Indy', lastName: 'Vidual', email: 'indy@example.test' })).ok).toBe(false); // already pending
    expect((await requestAccess(db, { firstName: 'X', lastName: 'Y', email: 'jordan.rivers@northbridge.test' })).ok).toBe(false); // has an account

    const req = (await listRequests(db, ids.users.admin)).find((x) => x.email_normalized === 'indy@example.test')!;
    expect(req.status).toBe('Pending');
    expect(await listRequests(db, ids.users.adminB)).toHaveLength(0); // other administrators cannot see requests
    await expect(decideRequest(db, ids.users.adminB, req.request_id, true)).rejects.toThrow(/permission/);
    await decideRequest(db, ids.users.admin, req.request_id, true);

    const token = (await linkFor('indy@example.test'))!.split('/register/')[1];
    expect(await registrationInfo(db, token)).toMatchObject({ ok: true, firstName: 'Indy', team: null });
    const done = await completeRegistration(db, token, { password: DEV_PASSWORD, dateOfBirth: '2001-01-01', mothersMaidenName: 'Example' });
    expect(done.ok).toBe(true);
    expect((await listRequests(db, ids.users.admin)).find((x) => x.request_id === req.request_id)?.status).toBe('Registered');

    // Same assessment and the same review gate; no team, and no college staff can see the record.
    const userId = done.ok ? done.userId : '';
    const t = await takeAssessment(db, userId, profile('A').answers);
    expect(t.result.ok).toBe(true);
    expect((await storedResult(db, t.instanceId)).hgi.hgi_display).toBe('100.0');
    expect(await athleteResult(db, userId)).toBeNull();
    for (const k of ['coach', 'leader', 'health', 'adminB'] as const) {
      const n = (await db.asUser(ids.users[k], (tx) => tx.query('select 1 from athlete_profile where email = $1', ['indy@example.test']))).rows.length;
      expect(n, k).toBe(0);
    }
  });

  it('a declined request gets no sign-up link', async () => {
    await requestAccess(db, { firstName: 'No', lastName: 'Thanks', email: 'decline@example.test' });
    const req = (await listRequests(db, ids.users.admin)).find((x) => x.email_normalized === 'decline@example.test')!;
    await decideRequest(db, ids.users.admin, req.request_id, false, 'Test decline');
    expect(await linkFor('decline@example.test')).toBeNull();
    await expect(decideRequest(db, ids.users.admin, req.request_id, true)).rejects.toThrow(/already/);
  });
});

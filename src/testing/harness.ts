// Runs fictional profiles through the real system (database, RLS, services) for acceptance evidence.
import type { Db } from '../server/db';
import { openAssessment, submitAssessment } from '../server/assessment';
import { uploadRoster } from '../server/roster';
import { registerAthlete } from '../server/seed';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail } from '../server/review';
import type { RawAnswers } from './fixtures';

let counter = 0;

/** Adds a fictional athlete to a team list and registers them through website sign-up (Way 1). */
export async function newAthlete(db: Db, adminUserId: string, teamId: string, label: string) {
  counter += 1;
  const email = `gs.${label.toLowerCase()}.${counter}@fixture.test`;
  await uploadRoster(db, adminUserId, teamId, `Fixture,${label}-${counter},${email}`);
  return registerAthlete(db, email, '2004-01-01', `Maiden${counter}`);
}

export function toForm(raw: RawAnswers): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v ?? undefined]));
}

/** Athlete takes and submits the assessment; returns the instance id and submit result. */
export async function takeAssessment(db: Db, athleteUserId: string, answers: RawAnswers) {
  const inst = await openAssessment(db, athleteUserId);
  const result = await submitAssessment(db, athleteUserId, inst.instance_id, toForm(answers));
  return { instanceId: inst.instance_id, result };
}

/** Authoritative stored backend values for one instance (TST-002), read directly from the database. */
export async function storedResult(db: Db, instanceId: string) {
  return db.system(async (tx) => {
    const q = <T>(sql: string) => tx.query<T>(sql, [instanceId]).then((r) => r.rows);
    const [inst] = await q<{ status: string; asm_version_id: string; scr_version_id: string; hga_version_id: string; rec_version_id: string; locked_at: string | null }>(
      'select status, asm_version_id, scr_version_id, hga_version_id, rec_version_id, locked_at from assessment_instance where instance_id = $1');
    const cats = await q<{ category: string; score_display: string | null; score_internal: string | null }>(
      'select category, score_display, score_internal from category_score where instance_id = $1 order by category');
    const [hgi] = await q<{ hgi_internal: string | null; hgi_display: string | null; band: string | null; status: string }>(
      'select hgi_internal, hgi_display, band, status from hgi_result where instance_id = $1');
    const findings = await q<{ rule_id: string; priority_class: number; source_class: string; finding_type: string; category: string }>(
      `select rule_id, priority_class, source_class, finding_type, category from hga_finding where instance_id = $1 and superseded_at is null order by finding_type = 'strength', rank, category`);
    const recs = await q<{ rule_id: string; pathway: string; status: string }>(
      'select f.rule_id, r.pathway, r.status from recommendation r join hga_finding f using (finding_id) where r.instance_id = $1 and r.superseded_at is null order by r.rank');
    const [validation] = await q<{ outcome: string; missing_items: string[] }>(
      'select outcome, missing_items from validation_result where instance_id = $1 order by checked_at desc limit 1');
    return { inst, cats, hgi, findings, recs, validation };
  });
}

/** WeCanH2O reviews a record, approves every recommendation and releases it to the athlete. */
export async function approveAndRelease(db: Db, adminUserId: string, instanceId: string) {
  await markReviewed(db, adminUserId, instanceId);
  for (const r of (await reviewDetail(db, adminUserId, instanceId))!.recommendations) {
    await decideRecommendation(db, adminUserId, { recId: r.rec_id, decision: 'approve' });
  }
  await releaseResults(db, adminUserId, instanceId);
}

// Fictional demo history for Milestone 5 (development / staging only). Run as part of `npm run db -- reset`.
// - Casey Morgan: baseline (released) 90 days ago -> reassessment now (released), showing improvement.
// - Taylor Reed: baseline (released) whose reassessment window closed without a reassessment (Outcome Unknown).
import type { Db } from '../server/db';
import type { SeedIds } from '../server/seed';
import { registerAthlete } from '../server/seed';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail } from '../server/review';
import { scheduleReassessment } from '../server/reassessment';
import { draftMaintenance } from '../server/assessment';
import { takeAssessment } from './harness';
import { BASE, PROFILES } from './fixtures';

async function release(db: Db, admin: string, instanceId: string) {
  await markReviewed(db, admin, instanceId);
  for (const r of (await reviewDetail(db, admin, instanceId))!.recommendations) {
    await decideRecommendation(db, admin, { recId: r.rec_id, decision: 'approve' });
  }
  await releaseResults(db, admin, instanceId);
}

async function backdate(db: Db, instanceId: string, days: number) {
  await db.system((tx) => tx.query(
    `update assessment_instance set started_at = started_at - make_interval(days => $2), submitted_at = submitted_at - make_interval(days => $2),
       validated_at = validated_at - make_interval(days => $2), released_at = released_at - make_interval(days => $2)
     where instance_id = $1`, [instanceId, days]));
  await db.system(async (tx) => {
    await tx.query(`update action_item set assigned_at = assigned_at - make_interval(days => $2)
      where rec_id in (select rec_id from recommendation where instance_id = $1)`, [instanceId, days]);
    await tx.query(`update recommendation set reviewed_at = reviewed_at - make_interval(days => $2), approved_at = approved_at - make_interval(days => $2),
      released_at = released_at - make_interval(days => $2) where instance_id = $1`, [instanceId, days]);
  });
}

export async function seedHistoryDemo(db: Db, ids: SeedIds) {
  const admin = ids.users.admin;
  const pid = async (user: string) =>
    (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [user]))).rows[0].participant_id;
  const today = new Date().toISOString().slice(0, 10);
  const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // Casey Morgan: knowledge-to-action gap at baseline, routine improves at reassessment.
  const casey = await registerAthlete(db, 'casey.morgan@northbridge.test', '2004-06-06', 'Demo');
  await db.system((tx) => tx.query('update athlete_team_affiliation set effective_start = current_date - 120 where participant_id = (select participant_id from participant where user_id = $1)', [casey]));
  const b = await takeAssessment(db, casey, PROFILES.find((p) => p.id === 'B')!.answers);
  await release(db, admin, b.instanceId);
  await backdate(db, b.instanceId, 90);
  await scheduleReassessment(db, admin, { tenantId: ids.tenantA, participantIds: [await pid(casey)], targetStart: today, targetEnd: plus(30) });
  const improved = { ...BASE, Q1: '3', Q2: '2', Q3: '2', Q4: '2', Q5: '1', Q33: 'PNA' };
  const r = await takeAssessment(db, casey, improved);
  await release(db, admin, r.instanceId);

  // Taylor Reed: window closed without a reassessment -> Outcome Unknown (never "no change").
  const taylor = await registerAthlete(db, 'taylor.reed@northbridge.test', '2004-07-07', 'Demo');
  await db.system((tx) => tx.query('update athlete_team_affiliation set effective_start = current_date - 120 where participant_id = (select participant_id from participant where user_id = $1)', [taylor]));
  const t = await takeAssessment(db, taylor, PROFILES.find((p) => p.id === 'C')!.answers);
  await release(db, admin, t.instanceId);
  await backdate(db, t.instanceId, 100);
  await scheduleReassessment(db, admin, { tenantId: ids.tenantA, participantIds: [await pid(taylor)], targetStart: today, targetEnd: plus(5) });
  await db.system((tx) => tx.query(`update reassessment_schedule set target_start = current_date - 30, target_end = current_date - 2
    where participant_id = (select participant_id from participant where user_id = $1)`, [taylor]));
  await draftMaintenance(db);
}

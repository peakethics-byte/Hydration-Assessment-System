// Fictional demo history for Milestone 5 (development / staging only). Run as part of `npm run db -- reset`.
// - Casey Morgan: baseline (released) 90 days ago -> reassessment now (released), showing improvement.
// - Taylor Reed: baseline (released) whose reassessment window closed without a reassessment (Outcome Unknown).
import type { Db } from '../server/db';
import type { SeedIds } from '../server/seed';
import { registerAthlete } from '../server/seed';
import { scheduleReassessment } from '../server/reassessment';
import { draftMaintenance } from '../server/assessment';
import { approveAndRelease, takeAssessment } from './harness';
import { BASE, PROFILES } from './fixtures';

const release = approveAndRelease;

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

// Fictional team populations for Milestone 6 (institution dashboard and reports). Two teams of six,
// so most figures are above the DRAFT privacy threshold of 5; three Track athletes are reassessed.
export async function seedReportDemo(db: Db, ids: SeedIds) {
  const admin = ids.users.admin;
  const { uploadRoster } = await import('../server/roster');
  const teams = [
    { team: ids.teams.trackField, prefix: 'tf', names: ['Alex Carter', 'Jamie Lee', 'Drew Patel', 'Sam Brooks', 'Kai Nguyen', 'Rowan Diaz'], profiles: ['A', 'B', 'C', 'E', 'F', 'G'] },
    { team: ids.teams.soccer, prefix: 'sc', names: ['Blake Moore', 'Emery Shaw', 'Jordan Kim', 'Reese Allen', 'Skyler Grant', 'Parker Lane'], profiles: ['B', 'C', 'F', 'G', 'A', 'C'] },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  for (const t of teams) {
    const rows = t.names.map((n, i) => { const [f, l] = n.split(' '); return `${f},${l},${t.prefix}.${f.toLowerCase()}.${l.toLowerCase()}@northbridge.test,NSU-${t.prefix.toUpperCase()}${i + 1}`; });
    await uploadRoster(db, admin, t.team, ['first_name,last_name,email,institution_athlete_id', ...rows].join('\n'));
    for (const [i, n] of t.names.entries()) {
      const [f, l] = n.split(' ');
      const user = await registerAthlete(db, `${t.prefix}.${f.toLowerCase()}.${l.toLowerCase()}@northbridge.test`, '2004-03-03', 'Demo');
      const pid = (await db.system((tx) => tx.query<{ participant_id: string }>('select participant_id from participant where user_id = $1', [user]))).rows[0].participant_id;
      await db.system((tx) => tx.query('update athlete_team_affiliation set effective_start = current_date - 60 where participant_id = $1', [pid]));
      const a = await takeAssessment(db, user, PROFILES.find((p) => p.id === t.profiles[i])!.answers);
      if (i < 4) await release(db, admin, a.instanceId);
      await backdate(db, a.instanceId, 30);
      if (t.prefix === 'tf' && i < 3) {
        await scheduleReassessment(db, admin, { tenantId: ids.tenantA, participantIds: [pid], targetStart: today, targetEnd: plus(30) });
        const r = await takeAssessment(db, user, PROFILES.find((p) => p.id === 'A')!.answers);
        await release(db, admin, r.instanceId);
      }
    }
  }
}

// One-time upgrade of an existing local database to Milestone 5 without losing data.
// - Migration 008 (reassessment, change analysis, history) runs automatically when the database opens.
// - The DRAFT A-HGA-1.0 test fixture gets the Milestone 3 change rules (persistent class 4, improvement amount).
//   Only fixture versions are touched; approved methodology is never rewritten.
// - Change analyses are computed for any reassessments already present.
// Run with the app stopped:  npx tsx scripts/upgrade-m5.ts
import path from 'node:path';
import { openDb } from '../src/server/db';
import { A_HGA_1_0 } from '../src/methodology/a-hga-1.0';
import { afterScored, SCORED } from '../src/server/reassessment';

async function main() {
  const db = await openDb(process.env.DB_DIR ?? path.join(process.cwd(), '.data', 'pgdata'));
  await db.system(async (tx) => {
    const r = await tx.query(`update rule_version set content = $1 where rule_version_id = 'A-HGA-1.0' and is_fixture`, [JSON.stringify(A_HGA_1_0)]);
    console.log(r.affectedRows ? 'A-HGA-1.0 (DRAFT fixture) updated with the Milestone 3 change rules.' : 'A-HGA-1.0 not changed (not a fixture).');
    const ps = (await tx.query<{ participant_id: string; instance_id: string }>(
      `select distinct on (participant_id) participant_id, instance_id from assessment_instance where status = any($1) order by participant_id, submitted_at desc`, [SCORED])).rows;
    for (const p of ps) await afterScored(tx, p.instance_id);
    console.log(`Change analyses refreshed for ${ps.length} athlete(s).`);
  });
  await db.pg.close();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });

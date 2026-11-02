// Local database commands: `npm run db -- reset` recreates .data/pgdata with fictional demo data.
import fs from 'node:fs';
import path from 'node:path';
import { assertDbFree, openDb } from '../src/server/db';
import { DEV_PASSWORD, seedDemo } from '../src/server/seed';
import { seedHistoryDemo, seedReportDemo } from '../src/testing/demo';

const dir = process.env.DB_DIR ?? path.join(process.cwd(), '.data', 'pgdata');
const cmd = process.argv[2] ?? 'reset';

async function main() {
  if (cmd !== 'reset') throw new Error(`Unknown command "${cmd}". Use: reset`);
  assertDbFree(dir); // never delete the database while the app has it open
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const db = await openDb(dir);
  const ids = await seedDemo(db);
  await seedHistoryDemo(db, ids); // Milestone 5 demo: an improvement over time and a missed reassessment
  await seedReportDemo(db, ids); // Milestone 6 demo: two teams of six for the dashboard and reports
  // Seed emails go to fictional .test addresses; never deliver them.
  await db.pg.query(`update email_outbox set status = 'Not sent - no email service configured' where status = 'Pending'`);
  await db.pg.close();
  console.log(`Database recreated at ${dir} with fictional demo data.`);
  console.log(`All seeded accounts use the test-only password defined in src/server/seed.ts (${DEV_PASSWORD.length} characters).`);
}

main().catch((e) => { console.error(e); process.exit(1); });

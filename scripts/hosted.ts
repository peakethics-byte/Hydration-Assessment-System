// Hosted database commands (Supabase). Uses DATABASE_URL, never the local .data folder.
//   npm run hosted -- migrate     apply any new migration files
//   npm run hosted -- seed-demo   load the fictional demo data (test site only; refuses if data exists)
//   npm run hosted -- status      show applied migrations and record counts
//   npm run hosted -- wipe-test-database   delete every table (test database only; asks for --confirm)
// IDENTITY_PEPPER must be the same value as in Vercel, so the demo identity hashes match the app.
import { migrate, openHostedDb } from '../src/server/db';
import { seedDemo } from '../src/server/seed';
import { seedHistoryDemo, seedReportDemo } from '../src/testing/demo';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to the Supabase connection string first.');
  // Demo accounts use fictional .test addresses: never send them real email.
  delete process.env.RESEND_API_KEY;
  const db = openHostedDb(url);
  const cmd = process.argv[2] ?? 'status';
  try {
    if (cmd === 'migrate') {
      const applied = await migrate(db);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is already up to date.');
    } else if (cmd === 'seed-demo') {
      if (!process.env.IDENTITY_PEPPER) throw new Error('Set IDENTITY_PEPPER (the same value as in Vercel) before seeding.');
      const n = (await db.raw((tx) => tx.query<{ n: number }>('select count(*)::int as n from tenant'))).rows[0].n;
      if (n > 0) throw new Error('This database already has data. Seeding is only for an empty test database.');
      const ids = await seedDemo(db);
      await seedHistoryDemo(db, ids);
      await seedReportDemo(db, ids);
      await db.raw((tx) => tx.query(`update email_outbox set status = 'Not sent - no email service configured' where status = 'Pending'`));
      console.log('Fictional demo data loaded. All demo accounts use the test-only password in src/server/seed.ts.');
    } else if (cmd === 'status') {
      const m = (await db.raw((tx) => tx.query<{ name: string }>('select name from schema_migration order by name'))).rows.map((r) => r.name);
      const c = (await db.raw((tx) => tx.query<{ tenants: number; users: number; assessments: number }>(
        'select (select count(*)::int from tenant) as tenants, (select count(*)::int from app_user) as users, (select count(*)::int from assessment_instance) as assessments'))).rows[0];
      console.log(`Migrations: ${m.join(', ')}`);
      console.log(`Institutions: ${c.tenants} · Users: ${c.users} · Assessments: ${c.assessments}`);
    } else if (cmd === 'wipe-test-database') {
      if (process.argv[3] !== '--confirm') throw new Error('This deletes every table and all data. Run it again with --confirm to go ahead.');
      const real = (await db.raw((tx) => tx.query<{ n: number }>(
        `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'tenant'`))).rows[0].n
        ? (await db.raw((tx) => tx.query<{ n: number }>(`select count(*)::int as n from tenant where display_name not like '%(Fictional)%' and tenant_kind <> 'personal'`))).rows[0].n
        : 0;
      if (real > 0) throw new Error('Refused: this database contains a non-fictional institution.');
      await db.raw(async (tx) => {
        await tx.exec('drop schema public cascade');
        await tx.exec('create schema public');
        await tx.exec('grant usage, create on schema public to current_user');
        await tx.exec(`do $$ begin if exists (select 1 from pg_roles where rolname = 'app_rw') then
          execute 'drop owned by app_rw'; execute 'drop role app_rw'; end if; end $$`);
      });
      console.log('Test database cleared. Run migrate, then seed-demo.');
    } else {
      throw new Error(`Unknown command "${cmd}". Use: migrate, seed-demo, status, wipe-test-database`);
    }
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e?.stack ?? e); if (e?.detail) console.error('Detail:', e.detail); if (e?.where) console.error('Where:', e.where); process.exit(1); });

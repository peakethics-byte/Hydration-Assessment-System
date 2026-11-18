// One-time upgrade for an existing local database: adds the "Individual Users" group (migration 007
// runs automatically on open). Safe to run more than once.
import path from 'node:path';
import { openDb } from '../src/server/db';
import { createProgramYear, createTenant } from '../src/server/institution';
import { PROGRAM_START } from '../src/server/seed';

async function main() {
  const db = await openDb(process.env.DB_DIR ?? path.join(process.cwd(), '.data', 'pgdata'));
  await db.system(async (tx) => {
    const exists = (await tx.query(`select 1 from tenant where tenant_kind = 'personal'`)).rows.length;
    if (exists) { console.log('Individual Users group already exists.'); return; }
    const t = await createTenant(tx, 'Individual Users (WeCanH2O)');
    await tx.query(`update tenant set tenant_kind = 'personal' where tenant_id = $1`, [t]);
    await createProgramYear(tx, t, PROGRAM_START);
    await tx.query(`insert into privacy_config (tenant_id, ack_required, ack_document_version_id) values ($1, false, 'ACK-PENDING-1')`, [t]);
    const admin = (await tx.query<{ user_id: string }>(`select user_id from app_user where email = 'admin@wecanh2o.test'`)).rows[0];
    if (admin) {
      await tx.query(`insert into role_assignment (user_id, role, tenant_id, scope_type) values ($1, 'program_admin', $2, 'tenant')`, [admin.user_id, t]);
    }
    console.log('Added the Individual Users group; admin@wecanh2o.test reviews its requests.');
  });
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

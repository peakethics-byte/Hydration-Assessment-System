// Fictional development / staging data. No real athletes, institutions or people.
import type { Db, Tx } from './db';
import { installCollegeAthleteRules } from './rules';
import { assignRole, createProgram, createProgramYear, createTeam, createTenant, createUser } from './institution';
import { completeRegistration, uploadRoster, websiteSignup } from './roster';

/** Test-only password for every seeded account. Development and staging only. */
export const DEV_PASSWORD = 'Hydrate-Test-2026';
export const PROGRAM_START = '2026-09-15';

export async function seedReference(tx: Tx) {
  await tx.query(`insert into population_module values ('A', 'College Athletes', 'Active'), ('B', 'Corporate / Occupational', 'Schema only'),
    ('C', 'Reserved for future populations', 'Reserved') on conflict do nothing`);
  await tx.query(
    `insert into personal_data_field (field_name, table_name, purpose, storage, approval_status) values
     ('first_name, last_name, email', 'athlete_profile', 'Identity and sign-up check against the team list sent by the college', 'Plain text', 'Approved'),
     ('institution_athlete_id', 'athlete_profile', 'Optional reference to the college roster', 'Plain text', 'Approved'),
     ('date_of_birth', 'athlete_profile', 'Reassessment identity matching (client decision Oct 16, 2026); emails can change', 'Plain date', 'Pending WeCanH2O approval'),
     ('mothers_maiden_name', 'athlete_profile', 'Reassessment identity matching (client decision Oct 16, 2026)', 'Keyed hash (HMAC-SHA256) only; plain value never stored', 'Pending WeCanH2O approval')
     on conflict do nothing`,
  );
}

export interface SeedIds {
  tenantA: string;
  tenantB: string;
  tenantP: string;
  teams: { trackField: string; soccer: string; lakeviewBasketball: string };
  users: Record<string, string>;
}

/** Registers a fictional athlete through the real Way 1 flow and returns the user id. */
export async function registerAthlete(db: Db, email: string, dob = '2005-04-12', maiden = 'Fictional') {
  const res = await websiteSignup(db, { firstName: 'x', lastName: 'x', email });
  if (!res.ok) throw new Error(`Seed sign-up failed for ${email}: ${res.message}`);
  // The link was emailed; read it from the local outbox.
  const link = (await db.system((tx) => tx.query<{ link: string }>(
    'select link from email_outbox where to_email = $1 order by email_id desc limit 1', [email]))).rows[0].link;
  const token = link.split('/register/')[1];
  const r = await completeRegistration(db, token, { password: DEV_PASSWORD, dateOfBirth: dob, mothersMaidenName: maiden });
  if (!r.ok) throw new Error(`Seed registration failed for ${email}: ${r.message}`);
  return r.userId;
}

export async function seedDemo(db: Db): Promise<SeedIds> {
  const base = await db.system(async (tx) => {
    await seedReference(tx);
    await installCollegeAthleteRules(tx, 'development');

    const tenantA = await createTenant(tx, 'Northbridge State University (Fictional)');
    await createProgramYear(tx, tenantA, PROGRAM_START);
    const progA = await createProgram(tx, tenantA, 'Athletics');
    const trackField = await createTeam(tx, tenantA, progA, 'Track & Field', 'Track & Field', 'exist');
    const soccer = await createTeam(tx, tenantA, progA, 'Soccer', 'Soccer', 'exist');

    const tenantB = await createTenant(tx, 'Lakeview College (Fictional)');
    await createProgramYear(tx, tenantB, PROGRAM_START);
    const progB = await createProgram(tx, tenantB, 'Athletics');
    const lakeviewBasketball = await createTeam(tx, tenantB, progB, 'Basketball', 'Basketball', 'exist');

    // Individual users (no college or team): their own tenant, kept separate from institutions.
    const tenantP = await createTenant(tx, 'Individual Users (WeCanH2O)');
    await tx.query(`update tenant set tenant_kind = 'personal' where tenant_id = $1`, [tenantP]);
    await createProgramYear(tx, tenantP, PROGRAM_START);

    // Acknowledgment capability: the wording is supplied by WeCanH2O, so the placeholder version is
    // not required for participation (ack_required = false) until real wording is approved.
    await tx.query(`insert into ack_document_version (document_version_id, text_ref, effective_from, body)
      values ('ACK-PENDING-1', 'Placeholder - wording supplied by WeCanH2O', $1, 'WeCanH2O') on conflict do nothing`, [PROGRAM_START]);
    for (const t of [tenantA, tenantB, tenantP]) {
      await tx.query(`insert into privacy_config (tenant_id, ack_required, ack_document_version_id) values ($1, false, 'ACK-PENDING-1')`, [t]);
    }

    const u: Record<string, string> = {};
    const mk = async (key: string, email: string, name: string) => (u[key] = await createUser(tx, email, name, DEV_PASSWORD));
    await mk('admin', 'admin@wecanh2o.test', 'Program Administrator (Test)');
    await assignRole(tx, u.admin, 'program_admin', tenantA, { type: 'tenant' }, { canExport: true });
    await assignRole(tx, u.admin, 'program_admin', tenantP); // reviews individual access requests
    await mk('adminB', 'admin.lakeview@wecanh2o.test', 'Program Administrator - Lakeview (Test)');
    await assignRole(tx, u.adminB, 'program_admin', tenantB);
    await mk('health', 'trainer@northbridge.test', 'Athletic Trainer (Test)');
    await assignRole(tx, u.health, 'health_support', tenantA, { type: 'team', id: trackField });
    await mk('coach', 'coach@northbridge.test', 'Track Coach (Test)');
    await assignRole(tx, u.coach, 'coach', tenantA, { type: 'team', id: trackField });
    await mk('leader', 'ad@northbridge.test', 'Athletic Director (Test)');
    await assignRole(tx, u.leader, 'inst_leader', tenantA);
    await mk('tech', 'tech@wecanh2o.test', 'Technical Administrator (Test)');
    await assignRole(tx, u.tech, 'tech_admin', null, { type: 'platform' });
    return { tenantA, tenantB, tenantP, teams: { trackField, soccer, lakeviewBasketball }, users: u };
  });

  // Team lists sent by the colleges (fictional names).
  await uploadRoster(db, base.users.admin, base.teams.trackField, [
    'first_name,last_name,email,institution_athlete_id',
    'Jordan,Rivers,jordan.rivers@northbridge.test,NSU-1001',
    'Avery,Brooks,avery.brooks@northbridge.test,NSU-1002',
    'Casey,Morgan,casey.morgan@northbridge.test,NSU-1003',
    'Taylor,Reed,taylor.reed@northbridge.test,NSU-1004',
  ].join('\n'));
  await uploadRoster(db, base.users.admin, base.teams.soccer, [
    'Riley,Hayes,riley.hayes@northbridge.test,NSU-2001',
    'Morgan,Ellis,morgan.ellis@northbridge.test,NSU-2002',
  ].join('\n'));
  await uploadRoster(db, base.users.adminB, base.teams.lakeviewBasketball, 'Quinn,Parker,quinn.parker@lakeview.test,LC-3001');

  // Two athletes already registered so the demo can start at the assessment; the rest stay on the
  // list to demonstrate Way 1 (website sign-up) and Way 2 (invitation) live.
  base.users.athlete1 = await registerAthlete(db, 'jordan.rivers@northbridge.test');
  base.users.athlete2 = await registerAthlete(db, 'riley.hayes@northbridge.test');
  base.users.athleteB = await registerAthlete(db, 'quinn.parker@lakeview.test');

  // Acceptance-test athletes (fictional): one account per gold-standard case, because each athlete
  // holds one assessment. Used by the Milestone 4 Client Acceptance Test Guide.
  const caseCodes = ['a', 'b', 'c', 'd1', 'd2', 'e', 'f', 'g', 'h', 'i1', 'i2', 'j', 'c4a', 'c4b', 'c3q4'];
  await uploadRoster(db, base.users.admin, base.teams.trackField,
    caseCodes.map((c) => `Test,Case ${c.toUpperCase()},test.${c}@northbridge.test`).join(String.fromCharCode(10)));
  for (const c of caseCodes) base.users[`case_${c}`] = await registerAthlete(db, `test.${c}@northbridge.test`, '2004-01-01', `Case${c}`);
  return base;
}

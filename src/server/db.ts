// Database access. Locally this is PGlite (PostgreSQL compiled to WebAssembly, stored in .data/);
// the same SQL migrations run unchanged on Supabase PostgreSQL in staging and production.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { deliverQueuedEmails } from './mailer';

export type Tx = Transaction;

export interface Db {
  pg: PGlite;
  /** Owner transaction: migrations, seeding and the server-side scoring pipeline. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Transaction as a signed-in user: role app_rw + app.user_id, so row-level security applies. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

async function migrate(pg: PGlite) {
  await pg.exec('create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await pg.query<{ name: string }>('select name from schema_migration')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await pg.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.query('insert into schema_migration (name) values ($1)', [file]);
    });
  }
}

/** The local database files support one process at a time. A second process (another app copy or a
 *  script) opening them while the app runs can damage them, so a lock file next to the folder refuses that. */
export function assertDbFree(dataDir: string) {
  const lock = `${dataDir}.lock`;
  if (!fs.existsSync(lock)) return;
  const pid = Number(fs.readFileSync(lock, 'utf8').trim());
  if (!pid || pid === process.pid) return;
  try {
    process.kill(pid, 0); // throws if that process no longer exists
  } catch {
    return; // stale lock from a process that has ended
  }
  throw new Error(`The local database is already open in another process (PID ${pid}). Stop the running app (Ctrl + C) first.`);
}

function lockDb(dataDir: string) {
  assertDbFree(dataDir);
  const lock = `${dataDir}.lock`;
  fs.writeFileSync(lock, String(process.pid));
  const release = () => {
    try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock); } catch { /* already gone */ }
  };
  process.once('exit', release);
}

export async function openDb(dataDir?: string): Promise<Db> {
  if (dataDir) lockDb(dataDir);
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await migrate(pg);
  // Emails queued in a transaction are delivered only after it commits.
  const afterCommit = <T>(p: Promise<T>) => p.then((v) => { void deliverQueuedEmails(pg); return v; });
  return {
    pg,
    system: (fn) => afterCommit(pg.transaction(fn)),
    asUser: (userId, fn) =>
      afterCommit(pg.transaction(async (tx) => {
        await tx.query("select set_config('app.user_id', $1, true)", [userId]);
        await tx.exec('set local role app_rw');
        return fn(tx);
      })),
  };
}

const g = globalThis as unknown as { __wecanh2oDb?: Promise<Db> };

/** Shared database for the running web app. */
export function getDb(): Promise<Db> {
  if (!g.__wecanh2oDb) {
    const dir = process.env.DB_DIR ?? path.join(process.cwd(), '.data', 'pgdata');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    g.__wecanh2oDb = openDb(dir);
  }
  return g.__wecanh2oDb;
}

// Database access.
// - Local development and tests: PGlite (PostgreSQL compiled to WebAssembly, stored in .data/).
// - Hosted (staging / production): PostgreSQL on Supabase, used when DATABASE_URL is set.
// Both run the same SQL migrations and the same row-level security; the rest of the code only sees `Db` and `Tx`.
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { deliverQueuedEmails } from './mailer';

export interface QueryResult<T> {
  rows: T[];
  affectedRows?: number;
}

/** One open transaction. */
export interface Tx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<unknown>;
}

export interface Db {
  kind: 'local' | 'hosted';
  /** Owner transaction: migrations, seeding and the server-side scoring pipeline. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Transaction as a signed-in user: role app_rw + app.user_id, so row-level security applies. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Plain owner transaction without the email hook (used by the mailer itself). */
  raw<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

/** Applies any migration files not yet recorded. Runs at start-up locally; `npm run hosted -- migrate` when hosted. */
export async function migrate(db: Pick<Db, 'raw'>) {
  await db.raw((tx) => tx.exec('create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())'));
  const done = new Set((await db.raw((tx) => tx.query<{ name: string }>('select name from schema_migration'))).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await db.raw(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.query('insert into schema_migration (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
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

const asUserSetup = async (tx: Tx, userId: string) => {
  await tx.query("select set_config('app.user_id', $1, true)", [userId]);
  await tx.exec('set local role app_rw');
};

/** Builds the Db API from one transaction runner. Emails queued in a transaction are sent after it commits. */
function build(kind: Db['kind'], run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, close: () => Promise<void>): Db {
  const db: Db = {
    kind,
    raw: run,
    close,
    system: (fn) => afterCommit(run(fn)),
    asUser: (userId, fn) => afterCommit(run(async (tx) => { await asUserSetup(tx, userId); return fn(tx); })),
  };
  // Locally delivery runs in the background. Hosted functions may stop once the response is sent,
  // so there the request waits for delivery (it never throws).
  const afterCommit = <T>(p: Promise<T>) =>
    p.then(async (v) => {
      const sending = deliverQueuedEmails(db);
      if (kind === 'hosted') await sending;
      return v;
    });
  return db;
}

/** Local PGlite database (folder) or an in-memory one for tests. */
export async function openDb(dataDir?: string): Promise<Db> {
  if (dataDir) lockDb(dataDir);
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = build('local', (fn) => lite.transaction((tx) => fn(tx as unknown as Tx)), () => lite.close());
  await migrate(db);
  return db;
}

/** Hosted PostgreSQL (Supabase). Migrations are applied separately with `npm run hosted -- migrate`. */
export function openHostedDb(connectionString: string): Db {
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 3),
    ssl: local ? false : { rejectUnauthorized: false },
    idleTimeoutMillis: 10_000,
  });
  const run = async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    const tx: Tx = {
      query: async (sql, params) => {
        const r = await client.query(sql, params as unknown[] | undefined);
        return { rows: r.rows, affectedRows: r.rowCount ?? 0 };
      },
      exec: (sql) => client.query(sql),
    };
    try {
      await client.query('begin');
      const v = await fn(tx);
      await client.query('commit');
      return v;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  };
  return build('hosted', run, () => pool.end());
}

const g = globalThis as unknown as { __wecanh2oDb?: Promise<Db> };

/** Shared database for the running web app: hosted when DATABASE_URL is set, otherwise the local folder. */
export function getDb(): Promise<Db> {
  if (!g.__wecanh2oDb) {
    if (process.env.DATABASE_URL) {
      g.__wecanh2oDb = Promise.resolve(openHostedDb(process.env.DATABASE_URL));
    } else {
      const dir = process.env.DB_DIR ?? path.join(process.cwd(), '.data', 'pgdata');
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      g.__wecanh2oDb = openDb(dir);
    }
  }
  return g.__wecanh2oDb;
}

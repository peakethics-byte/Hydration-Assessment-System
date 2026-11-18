// Runs every gold-standard check through the hosted PostgreSQL driver (node-postgres), against a
// local PostgreSQL wire-protocol server, so hosting problems show up before deployment.
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

async function main() {
  const lite = await PGlite.create();
  const server = new PGLiteSocketServer({ db: lite, port: 55432, host: '127.0.0.1' });
  await server.start();
  // Async spawn: the wire server lives in this process and must keep answering while the checks run.
  const status = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/gold-standard.ts'], {
      stdio: 'inherit',
      env: { ...process.env, CHECK_HOSTED_URL: 'postgres://postgres@127.0.0.1:55432/postgres', PG_POOL_MAX: '1', RESEND_API_KEY: '', GOLD_OUT: 'test-evidence/hosted-check' },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  await server.stop();
  await lite.close();
  process.exit(status);
}
main().catch((e) => { console.error(e); process.exit(1); });

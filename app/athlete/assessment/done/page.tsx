import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { loadRuleSet } from '@/src/server/rules';
import { athleteHome } from '@/src/server/assessment';

export default async function Done() {
  const u = await requireUser('athlete');
  const db = await getDb();
  const { instance } = await athleteHome(db, u.userId);
  const closing = instance
    ? (await db.system((tx) => loadRuleSet(tx, { asmId: instance.asm_version_id, scrId: instance.scr_version_id, hgaId: instance.hga_version_id, recId: instance.rec_version_id }))).asm.closingStatement
    : '';
  return (
    <main className="narrow">
      <h1>Submitted</h1>
      <div className="card">
        <p>{closing}</p>
        <p className="muted">WeCanH2O reviews every result before it is shared with you. You will see your results here after the review.</p>
        <a className="button" href="/athlete">Back to my page</a>
      </div>
    </main>
  );
}

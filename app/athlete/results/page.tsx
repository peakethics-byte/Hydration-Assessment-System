import { getDb } from '@/src/server/db';
import { athleteResult, completeActionItem } from '@/src/server/assessment';
import { requireUser } from '@/src/server/session';
import { A_REC_1_0 } from '@/src/methodology/a-rec-1.0';
import { revalidatePath } from 'next/cache';
import HgiRing from '@/src/ui/HgiRing';

const PATHWAY = Object.fromEntries(A_REC_1_0.pathways.map((p) => [p.code, p.name]));

async function markDone(form: FormData) {
  'use server';
  const u = await requireUser('athlete');
  await completeActionItem(await getDb(), u.userId, String(form.get('id')));
  revalidatePath('/athlete/results');
}

export default async function Results() {
  const u = await requireUser('athlete');
  const r = await athleteResult(await getDb(), u.userId);
  if (!r) {
    return (
      <main className="narrow">
        <h1>My results</h1>
        <div className="notice">Your results are not ready yet. WeCanH2O reviews every result before it is shared with you.</div>
      </main>
    );
  }
  return (
    <main className="narrow">
      <h1>My results</h1>
      <p className="muted small">Shared {r.releasedAt ? new Date(r.releasedAt).toLocaleDateString('en-US', { dateStyle: 'long' }) : ''}. This is not a medical diagnosis.</p>
      <div className="card gauge">
        <HgiRing value={Number(r.hgiDisplay ?? 0)} />
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Hydration Gap Index (HGI)</div>
          <div className="hgi">{r.hgiDisplay}</div>
          <div className={`band band-${(r.band ?? '').split(' ')[0]}`}>{r.band}</div>
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>The HGI shows how much overall alignment your hydration habits show, from 0 to 100.</p>
        </div>
      </div>

      {r.priorities.some((p) => p.isSafety) && (
        <div className="card safety">
          <strong>Please follow up with your athletic trainer or health-support staff.</strong>
          <p className="small" style={{ marginBottom: 0 }}>
            If you are experiencing symptoms or have health concerns, follow your institution&apos;s approved athletic-training, sports-medicine, or health-support procedures.
          </p>
        </div>
      )}

      <h2>Strengths</h2>
      {r.strengths.length ? (
        <ul className="list-clean">{r.strengths.map((s) => <li key={s}><span className="dot okc">&#10003;</span><span>{s}</span></li>)}</ul>
      ) : <p className="muted">No strengths listed.</p>}

      <h2>Priorities</h2>
      {r.priorities.length ? (
        <ul className="list-clean">
          {r.priorities.map((p, i) => (
            <li key={p.title}>
              <span className="dot">{i + 1}</span>
              <span>
                {p.title}
                {p.source === 'Institutional/Environmental' && <span className="muted small"> - this relates to your campus environment</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="muted">No priorities were identified.</p>}

      <h2>Individualized Hydration Strategy</h2>
      <p className="muted small">Your Hydration Action Items, approved by WeCanH2O.</p>
      {r.actionItems.length === 0 && <p className="muted">No action items.</p>}
      {r.actionItems.map((a) => (
        <div className="card" key={a.action_item_id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="pill">{PATHWAY[a.pathway]}</span>
            <span className={`pill${a.status.startsWith('Completed') ? ' ok' : ''}`}>{a.status}</span>
          </div>
          <p>{a.athlete_text}</p>
          {a.status === 'Assigned / Delivered' && (
            <form action={markDone}><input type="hidden" name="id" value={a.action_item_id} /><button className="secondary">Mark as done</button></form>
          )}
        </div>
      ))}
    </main>
  );
}

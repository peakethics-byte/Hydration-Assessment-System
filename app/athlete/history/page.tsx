import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { athleteHome } from '@/src/server/assessment';
import { athleteHistory } from '@/src/server/history';
import TrendChart from '@/src/ui/TrendChart';
import { mediumDate } from '@/src/domain/format';

const day = (d: string | null) => mediumDate(d);
const STATE_TEXT: Record<string, string> = {
  Improved: 'Improved', Resolved: 'No longer a gap', Persistent: 'Still a priority', Worsened: 'Needs more attention', New: 'New',
};

// The athlete's own history. Row-level security returns results only for assessments WeCanH2O has
// released, so nothing unapproved can appear here. No rule IDs, points or formulas are shown.
export default async function MyHistory() {
  const u = await requireUser('athlete');
  const db = await getDb();
  const { profile } = await athleteHome(db, u.userId);
  const h = profile ? await athleteHistory(db, u.userId, profile.participant_id) : null;
  if (!h) return <main className="narrow"><h1>My history</h1><p className="muted">No history yet.</p></main>;

  const released = h.instances.filter((i) => i.hgi_display != null);
  const analysis = h.analyses[h.analyses.length - 1];
  const changes = analysis ? h.findingChanges.filter((f) => f.change_analysis_id === analysis.change_analysis_id) : [];
  const group = (states: string[]) => changes.filter((c) => states.includes(c.state));
  const latest = released[released.length - 1];
  const strengths = latest ? h.strengths.filter((s) => s.instance_id === latest.instance_id).map((s) => s.title) : [];
  const comparable = analysis?.comparison_status === 'Comparable';

  return (
    <main className="narrow">
      <h1>My history</h1>
      <p className="muted">Your Structured Hydration Assessments over time. Results appear here after WeCanH2O reviews and releases them. This is not a medical diagnosis.</p>

      <h2>My HGI over time</h2>
      <div className="card"><TrendChart points={released.map((i) => ({ label: day(i.submitted_at), hgi: Number(i.hgi_display), band: i.band ?? '', kind: i.is_baseline ? 'First assessment' : 'Reassessment' }))} /></div>

      {analysis && comparable && (
        <>
          <h2>What changed since my first assessment</h2>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Overall change</h3>
            <p>Your HGI went from {Number(analysis.hgi_baseline).toFixed(1)} to {Number(analysis.hgi_current).toFixed(1)}{' '}
              (<span className={`delta ${Number(analysis.hgi_change) >= 0 ? 'up' : 'down'}`}>{Number(analysis.hgi_change) >= 0 ? '+' : ''}{Number(analysis.hgi_change).toFixed(1)}</span>).</p>
            <h3>Improvements</h3>
            {group(['Improved', 'Resolved']).length ? <ul className="summary-list">{group(['Improved', 'Resolved']).map((c) => <li key={c.title}><span className={`state ${c.state}`}>{STATE_TEXT[c.state]}</span> {c.title}</li>)}</ul> : <p className="muted">None this time.</p>}
            <h3>Continuing priorities</h3>
            {group(['Persistent', 'Worsened']).length ? <ul className="summary-list">{group(['Persistent', 'Worsened']).map((c) => <li key={c.title}><span className={`state ${c.state}`}>{STATE_TEXT[c.state]}</span> {c.title}</li>)}</ul> : <p className="muted">None.</p>}
            <h3>New findings</h3>
            {group(['New']).length ? <ul className="summary-list">{group(['New']).map((c) => <li key={c.title}><span className="state New">New</span> {c.title}</li>)}</ul> : <p className="muted">None.</p>}
            <h3>Strengths</h3>
            {strengths.length ? <ul className="summary-list">{strengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted">None listed.</p>}
            <h3>Updated strategy</h3>
            <p style={{ marginBottom: 0 }}>Your updated Hydration Action Items are on <a href="/athlete/results">My results</a>.</p>
          </div>
        </>
      )}

      <h2>All my assessments</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Date</th><th>Type</th><th>Status</th><th>HGI</th><th>Band</th></tr></thead>
        <tbody>
          {h.instances.length === 0 && <tr><td colSpan={5} className="muted">None yet.</td></tr>}
          {h.instances.map((i) => (
            <tr key={i.instance_id}>
              <td>{day(i.submitted_at)}</td>
              <td>{i.is_baseline ? 'First assessment' : 'Reassessment'}</td>
              <td>{i.status === 'Released' ? 'Results shared' : i.status === 'In Progress' || i.status === 'Not Started' ? 'In progress' : 'Being reviewed'}</td>
              <td>{i.hgi_display ? Number(i.hgi_display).toFixed(1) : '-'}</td>
              <td>{i.band ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      {latest && h.interventions.some((a) => !a.superseded && a.instance_id === latest.instance_id) && (
        <>
          <h2>My current Hydration Action Items</h2>
          <p className="muted small">From your latest released assessment. Earlier action items stay on record with WeCanH2O.</p>
          <ul className="list-clean">
            {h.interventions.filter((a) => !a.superseded && a.instance_id === latest.instance_id).map((a) => (
              <li key={a.action_item_id}>
                <span className={`dot${a.status.startsWith('Completed') ? ' okc' : ''}`}>{a.status.startsWith('Completed') ? '✓' : '•'}</span>
                <span>{a.finding} <span className="muted small">· {a.status.startsWith('Completed') ? `done ${day(a.completed_at)}` : `since ${day(a.assigned_at)}`}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { athleteFilterOptions, searchAthletes, type AthleteFilters } from '@/src/server/history';
import { OUTCOME_UNKNOWN, SEARCHABLE } from '@/src/domain/status';
import { shortDate } from '@/src/domain/format';

const BANDS = ['Minimal Gap', 'Mild Gap', 'Moderate Gap', 'Significant Gap', 'Critical Gap'];
const STATUSES = SEARCHABLE;
const fmt = (d: string | null) => shortDate(d);

export default async function Athletes({ searchParams }: { searchParams: Promise<AthleteFilters> }) {
  const u = await requireUser('program_admin', 'health_support');
  const f = await searchParams;
  const db = await getDb();
  const [rows, opts] = await Promise.all([searchAthletes(db, u.userId, f), athleteFilterOptions(db, u.userId)]);
  const reassessment = (r: (typeof rows)[number]) =>
    r.window_end ? <span className="pill brand">Open until {fmt(r.window_end)}</span>
      : r.last_outcome === OUTCOME_UNKNOWN ? <span className="pill warn" title={OUTCOME_UNKNOWN}>Outcome unknown</span>
        : r.last_outcome === 'Completed' ? <span className="pill ok">Completed</span>
          : <span className="muted">-</span>;

  return (
    <main>
      <h1>Athletes</h1>
      <p className="muted">Search and filter athletes, then open one to see their full assessment history, change since baseline and reassessments.</p>

      <form className="card filters" method="get">
        <input type="text" name="q" defaultValue={f.q ?? ''} placeholder="Name, email or Athlete ID" aria-label="Search" />
        {opts.tenants.length > 1 && (
          <select name="tenantId" defaultValue={f.tenantId ?? ''} aria-label="Institution">
            <option value="">All institutions</option>
            {opts.tenants.map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.display_name}</option>)}
          </select>
        )}
        <select name="teamId" defaultValue={f.teamId ?? ''} aria-label="Team">
          <option value="">All teams</option>
          {opts.teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}{opts.tenants.length > 1 ? ` (${t.institution})` : ''}</option>)}
        </select>
        <select name="status" defaultValue={f.status ?? ''} aria-label="Assessment status">
          <option value="">Any status</option>
          <option value="none">Not started</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="band" defaultValue={f.band ?? ''} aria-label="HGI band">
          <option value="">Any band</option>
          {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select name="reassessment" defaultValue={f.reassessment ?? ''} aria-label="Reassessment">
          <option value="">Any reassessment</option>
          <option value="open">Window open</option>
          <option value="unknown">Outcome unknown</option>
          <option value="completed">Completed</option>
          <option value="none">Not scheduled</option>
        </select>
        <label className="row" style={{ margin: 0, fontWeight: 500 }}>
          <input type="checkbox" name="safety" value="yes" defaultChecked={f.safety === 'yes'} /> Safety findings only
        </label>
        <div className="row">
          <button>Apply</button>
          <a className="button secondary" href="/athletes">Clear</a>
        </div>
      </form>

      <p className="muted small">{rows.length} athlete{rows.length === 1 ? '' : 's'}</p>
      <div className="table-wrap"><table className="users-table">
        <thead><tr><th>Athlete</th><th>Team</th><th>Latest status</th><th>HGI</th><th>Change since baseline</th><th>Reassessment</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} className="muted">No athletes match.</td></tr>}
          {rows.map((r) => (
            <tr key={r.participant_id}>
              <td>
                <div className="cell-main">{r.first_name} {r.last_name} {r.safety > 0 && <span className="pill safety tiny">Safety</span>}</div>
                <div className="cell-sub">{r.athlete_code} · {r.email}</div>
              </td>
              <td className="cell-sub-strong">{r.teams ?? 'Individual'}</td>
              <td>{r.latest_status ?? <span className="muted">Not started</span>}</td>
              <td>{r.latest_hgi ? <><strong>{Number(r.latest_hgi).toFixed(1)}</strong><div className="cell-sub">{r.latest_band}</div></> : <span className="muted">-</span>}</td>
              <td>
                {r.comparison_status && r.comparison_status !== 'Comparable'
                  ? <span className="pill warn">Review required</span>
                  : r.hgi_change != null
                    ? <span className={`delta ${Number(r.hgi_change) >= 0 ? 'up' : 'down'}`}>{Number(r.hgi_change) >= 0 ? '+' : ''}{Number(r.hgi_change).toFixed(1)}</span>
                    : <span className="muted">-</span>}
              </td>
              <td>{reassessment(r)}</td>
              <td className="cell-actions"><a className="button secondary btn-sm" href={`/athletes/${r.participant_id}`}>Open</a></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </main>
  );
}

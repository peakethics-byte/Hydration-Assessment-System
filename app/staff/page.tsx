import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { staffOverview } from '@/src/server/admin';

export default async function Staff() {
  const u = await requireUser('health_support', 'coach', 'inst_leader', 'tech_admin');
  const roles = new Set(u.roles.map((r) => r.role));
  const { athletes, teams } = await staffOverview(await getDb(), u.userId);
  return (
    <main>
      <h1>Overview</h1>
      {(roles.has('health_support') || athletes.length > 0) && (
        <>
          <p className="muted">{roles.has('health_support') ? 'Assigned athletes only.' : 'Athletes WeCanH2O has given you time-limited access to.'} Safety findings are listed first.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Athlete</th><th>Status</th><th>HGI</th><th>Band</th><th>Safety</th></tr></thead>
            <tbody>{athletes.map((a) => (
              <tr key={a.athlete_code}>
                <td><a href={`/athletes/${a.participant_id}`}>{a.first_name} {a.last_name}</a> <span className="muted small">{a.athlete_code}</span></td>
                <td>{a.status ?? 'Not started'}</td>
                <td>{a.hgi_display ? Number(a.hgi_display).toFixed(1) : '-'}</td>
                <td>{a.band ?? '-'}</td>
                <td>{a.safety ? <span className="pill safety">{a.safety}</span> : '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}
      {(roles.has('coach') || roles.has('inst_leader')) && (
        <div className="card">
          <p>Your teams: {teams.map((t) => `${t.name} (${t.institution})`).join(', ') || 'none'}.</p>
          <p>
            Coaches and college leaders see group results only. Team and college reports come in a later milestone.
            Individual athlete results are not visible unless WeCanH2O grants explicit, time-limited access.
          </p>
        </div>
      )}
      {roles.has('tech_admin') && (
        <div className="card">
          <p>Technical System Administrator: infrastructure and technical accounts only. No access to athlete data, approvals or business exports.</p>
        </div>
      )}
    </main>
  );
}

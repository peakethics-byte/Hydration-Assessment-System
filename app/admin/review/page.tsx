import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { reviewQueue } from '@/src/server/review';
import { dateTime } from '@/src/domain/format';

export default async function ReviewQueue() {
  const u = await requireUser('program_admin');
  const rows = await reviewQueue(await getDb(), u.userId);
  return (
    <main>
      <h1>Review queue</h1>
      <p className="muted">Nothing is shown to an athlete until a WeCanH2O reviewer approves and releases it. Records with safety findings are listed first.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Athlete</th><th>Team</th><th>Submitted</th><th>HGI</th><th>Band</th><th>Safety</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={8} className="muted">No submitted assessments.</td></tr>}
          {rows.map((r) => (
            <tr key={r.instance_id}>
              <td>{r.first_name} {r.last_name}<div className="muted small">{r.athlete_code}</div></td>
              <td>{r.team ?? '-'}<div className="muted small">{r.institution}</div></td>
              <td>{dateTime(r.submitted_at)}</td>
              <td>{r.hgi_display ? Number(r.hgi_display).toFixed(1) : '-'}</td>
              <td>{r.band ?? '-'}</td>
              <td>{r.safety > 0 ? <span className="pill safety">{r.safety} safety</span> : '-'}</td>
              <td>{r.status}</td>
              <td><a href={`/admin/review/${r.instance_id}`}>Open</a></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </main>
  );
}

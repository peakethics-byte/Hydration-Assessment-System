import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { auditLog } from '@/src/server/admin';

export default async function Audit() {
  const u = await requireUser('program_admin');
  const rows = await auditLog(await getDb(), u.userId);
  return (
    <main>
      <h1>Audit log</h1>
      <p className="muted">Append-only. Events for your institutions, newest first.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Record</th><th>Change</th><th>Rule version</th></tr></thead>
        <tbody>{rows.map((e) => (
          <tr key={e.event_id}>
            <td className="small">{new Date(e.created_at).toLocaleString('en-US')}</td>
            <td>{e.actor ?? 'System'}</td>
            <td>{e.action}</td>
            <td className="small">{e.record_type}</td>
            <td className="small">
              {e.old_value ? `${JSON.stringify(e.old_value)} -> ` : ''}{e.new_value ? JSON.stringify(e.new_value) : ''}{e.reason ? ` (${e.reason})` : ''}
            </td>
            <td className="small">{e.rule_version_id ?? ''}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </main>
  );
}

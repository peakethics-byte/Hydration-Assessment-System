import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { decideRequest, listRequests } from '@/src/server/accounts';
import { dateTime, mediumDate } from '@/src/domain/format';

async function decide(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const approve = form.get('decision') === 'approve';
  let msg = approve ? 'Approved. A sign-up link was emailed.' : 'Declined.';
  try {
    await decideRequest(await getDb(), u.userId, String(form.get('requestId')), approve, String(form.get('note') ?? ''));
  } catch (e) { msg = (e as Error).message; }
  redirect(`/admin/requests?msg=${encodeURIComponent(msg)}`);
}

export default async function Requests({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const u = await requireUser('program_admin');
  const sp = await searchParams;
  const rows = await listRequests(await getDb(), u.userId);
  const pending = rows.filter((r) => r.status === 'Pending');
  const done = rows.filter((r) => r.status !== 'Pending');
  return (
    <main>
      <h1>Individual access requests</h1>
      <p className="muted">People who are not on a college team list. When you approve, they get an email link to finish signing up (password, date of birth, mother&apos;s maiden name). Their results stay private to them and WeCanH2O.</p>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}

      <h2>Waiting for review ({pending.length})</h2>
      {pending.length === 0 && <p className="muted">No requests waiting.</p>}
      {pending.map((r) => (
        <form action={decide} className="card row" key={r.request_id}>
          <input type="hidden" name="requestId" value={r.request_id} />
          <div style={{ flex: '1 1 240px' }}>
            <strong>{r.first_name} {r.last_name}</strong>
            <div className="muted small">{r.email_normalized} · requested {dateTime(r.requested_at)}</div>
          </div>
          <input type="text" name="note" placeholder="Note (optional)" style={{ width: 220 }} aria-label="Note" />
          <button name="decision" value="approve">Approve</button>
          <button className="secondary" name="decision" value="decline">Decline</button>
        </form>
      ))}

      <h2>History</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Decided</th><th>Note</th></tr></thead>
        <tbody>
          {done.length === 0 && <tr><td colSpan={5} className="muted">None yet.</td></tr>}
          {done.map((r) => (
            <tr key={r.request_id}>
              <td>{r.first_name} {r.last_name}</td><td>{r.email_normalized}</td>
              <td><span className={`pill${r.status === 'Declined' ? '' : ' ok'}`}>{r.status}</span></td>
              <td className="small">{r.decided_at ? `${mediumDate(r.decided_at)} · ${r.decided_by_name ?? ''}` : '-'}</td>
              <td className="small">{r.decision_note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </main>
  );
}

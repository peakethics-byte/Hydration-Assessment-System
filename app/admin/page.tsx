import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { adminOverview, setAckRequired } from '@/src/server/admin';
import { draftMaintenance, reopenDraft } from '@/src/server/assessment';
import { sendInvitations, uploadRoster } from '@/src/server/roster';
import { setTeamProcedures } from '@/src/server/review';
import { scheduleReassessment, windowSuggestion } from '@/src/server/reassessment';
import { dateTime } from '@/src/domain/format';

async function upload(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const r = await uploadRoster(await getDb(), u.userId, String(form.get('teamId')), String(form.get('csv') ?? ''));
  const skipped = r.skipped.map((s) => `line ${s.line}: ${s.reason}`).join('; ');
  redirect(`/admin?msg=${encodeURIComponent(`Added ${r.added} athlete(s) to the team list.${skipped ? ` Skipped - ${skipped}` : ''}`)}`);
}

async function invite(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const r = await sendInvitations(await getDb(), u.userId, String(form.get('teamId')));
  redirect(`/admin?msg=${encodeURIComponent(`Sent ${r.sent} invitation email(s).`)}`);
}

async function procedures(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  await setTeamProcedures(await getDb(), u.userId, String(form.get('teamId')), String(form.get('value')) as 'exist' | 'none' | 'unknown');
  redirect('/admin?msg=Team%20procedure%20status%20saved.');
}

async function reopen(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  let msg = 'Draft reopened with a new draft window. The saved answers are kept.';
  try { await reopenDraft(await getDb(), u.userId, String(form.get('instanceId'))); } catch (e) { msg = (e as Error).message; }
  redirect(`/admin?msg=${encodeURIComponent(msg)}`);
}

async function ackSetting(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  await setAckRequired(await getDb(), u.userId, String(form.get('tenantId')), form.get('required') === 'on');
  redirect('/admin?msg=Acknowledgment%20setting%20saved.');
}

async function reassess(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  let msg: string;
  try {
    const r = await scheduleReassessment(await getDb(), u.userId, {
      tenantId: String(form.get('tenantId')), teamId: String(form.get('teamId')),
      targetStart: String(form.get('start')), targetEnd: String(form.get('end')),
    });
    const skipped = r.skipped.length ? ` Not opened for ${r.skipped.length}: ${r.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}.` : '';
    msg = `Reassessment window opened for ${r.scheduled.length} athlete(s); they were emailed.${skipped}`;
  } catch (e) { msg = (e as Error).message; }
  redirect(`/admin?msg=${encodeURIComponent(msg)}`);
}

const PROC: Record<string, string> = { exist: 'Procedures exist', none: 'No procedures recorded', unknown: 'Not yet recorded' };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  const u = await requireUser('program_admin');
  const sp = await searchParams;
  const db = await getDb();
  await draftMaintenance(db); // reminders and expiry (a scheduled job in staging)
  const { teams, roster, duplicates, expired, privacy } = await adminOverview(db, u.userId);
  const suggest = new Map(await Promise.all([...new Set(teams.map((t) => t.tenant_id))].map(async (id) => [id, await windowSuggestion(db, id)] as const)));
  return (
    <main>
      <h1>Teams and athlete sign-up</h1>
      <p className="muted">The college sends the team list first. Athletes then sign up on the website (their email is checked against the list) or you send them an invitation.</p>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}

      {teams.map((t) => (
        <div className="card" key={t.team_id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0 }}>{t.name} <span className="muted small">· {t.institution}</span></h2>
            <span className="small">Listed {t.listed} · Invited {t.invited} · Link sent {t.link_sent} · Registered {t.registered}</span>
          </div>
          <div className="grid2">
            <form action={upload}>
              <input type="hidden" name="teamId" value={t.team_id} />
              <label htmlFor={`csv-${t.team_id}`}>Add to team list (CSV)</label>
              <textarea id={`csv-${t.team_id}`} name="csv" placeholder={'first_name,last_name,email,institution_athlete_id\nAlex,Sample,alex.sample@college.test,ID-1'} />
              <p><button className="secondary">Add to team list</button></p>
            </form>
            <div>
              <form action={invite}>
                <input type="hidden" name="teamId" value={t.team_id} />
                <label>Way 2 - invitation</label>
                <p className="small muted">Emails a sign-up link to every athlete on this list who has not been invited yet ({t.listed}).</p>
                <button disabled={t.listed === 0}>Send invitations</button>
              </form>
              <form action={reassess}>
                <input type="hidden" name="teamId" value={t.team_id} />
                <input type="hidden" name="tenantId" value={t.tenant_id} />
                <label>Reassessment window</label>
                <p className="small muted">Opens a reassessment for every athlete on this team who has a completed baseline. Default: the next quarter ({suggest.get(t.tenant_id)?.label}).</p>
                <div className="row">
                  <input type="date" name="start" required defaultValue={suggest.get(t.tenant_id)?.start} style={{ width: 'auto' }} aria-label="Window start" />
                  <input type="date" name="end" required defaultValue={suggest.get(t.tenant_id)?.end} style={{ width: 'auto' }} aria-label="Window end" />
                  <button className="secondary">Open window</button>
                </div>
              </form>
              <form action={procedures}>
                <input type="hidden" name="teamId" value={t.team_id} />
                <label htmlFor={`proc-${t.team_id}`}>Team hydration / heat-safety procedures</label>
                <div className="row">
                  <select id={`proc-${t.team_id}`} name="value" defaultValue={t.heat_safety_procedures} style={{ width: 'auto' }}>
                    {Object.entries(PROC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="secondary">Save</button>
                </div>
                <p className="small muted">When no procedures exist, a low Q15A/Q15B is treated as an institutional finding, not athlete noncompliance.</p>
              </form>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Athlete ID</th></tr></thead>
              <tbody>
                {roster.filter((r) => r.team_id === t.team_id).map((r) => (
                  <tr key={r.roster_entry_id}><td>{r.first_name} {r.last_name}</td><td>{r.email_normalized}</td><td>{r.status}</td><td>{r.athlete_code ?? '-'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <h2>Expired drafts</h2>
      <p className="muted small">Drafts not submitted within the draft window. The answers are kept; you can reopen a draft with a new window.</p>
      {expired.length === 0 ? <p className="muted">None.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Athlete</th><th>Last saved</th><th></th></tr></thead>
          <tbody>{expired.map((e) => (
            <tr key={e.instance_id}>
              <td>{e.first_name} {e.last_name} <span className="muted small">{e.athlete_code}</span></td>
              <td>{dateTime(e.last_saved_at)}</td>
              <td><form action={reopen}><input type="hidden" name="instanceId" value={e.instance_id} /><button className="secondary">Reopen</button></form></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}

      <h2>Participation acknowledgment</h2>
      <p className="muted small">When switched on, athletes must acknowledge the current statement before they can answer. The wording is supplied by WeCanH2O; each acknowledgment records the version shown and the time.</p>
      {privacy.map((p) => (
        <form action={ackSetting} className="card row" key={p.tenant_id}>
          <input type="hidden" name="tenantId" value={p.tenant_id} />
          <strong>{p.institution}</strong>
          <label className="row" style={{ margin: 0, fontWeight: 400 }}>
            <input type="checkbox" name="required" defaultChecked={p.ack_required} /> Required before the assessment
          </label>
          <span className="muted small">Version {p.ack_document_version_id ?? 'none'} · Draft window {p.draft_days} days</span>
          <button className="secondary">Save</button>
        </form>
      ))}

      <h2>Potential duplicates (review needed)</h2>
      <p className="muted small">Athletes are never merged automatically on name.</p>
      {duplicates.length === 0 ? <p className="muted">None.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>New record</th><th>Possible match</th><th>Reason</th></tr></thead>
          <tbody>{duplicates.map((d) => <tr key={d.duplicate_review_id}><td>{d.a_name} ({d.a_code})</td><td>{d.b_name} ({d.b_code})</td><td>{d.reason}</td></tr>)}</tbody>
        </table></div>
      )}
    </main>
  );
}

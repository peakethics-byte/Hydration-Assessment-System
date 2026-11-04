import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { athleteHistory, grantAccess, resolveDuplicate, revokeAccess, transferAthlete } from '@/src/server/history';
import { cancelSchedule, OUTCOME_UNKNOWN, scheduleReassessment, windowSuggestion } from '@/src/server/reassessment';
import { A_REC_1_0 } from '@/src/methodology/a-rec-1.0';
import TrendChart from '@/src/ui/TrendChart';
import { mediumDate } from '@/src/domain/format';

const PATHWAY = Object.fromEntries(A_REC_1_0.pathways.map((p) => [p.code, p.name]));
const day = (d: string | null) => mediumDate(d);
const num = (v: string | null, dp = 1) => (v == null ? '-' : Number(v).toFixed(dp));
const signed = (v: string | null) => (v == null ? '-' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}`);

async function act(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const db = await getDb();
  const id = String(form.get('participantId'));
  const what = String(form.get('what'));
  let msg = '';
  try {
    if (what === 'schedule') {
      const r = await scheduleReassessment(db, u.userId, { tenantId: String(form.get('tenantId')), participantIds: [id],
        targetStart: String(form.get('start')), targetEnd: String(form.get('end')) });
      msg = r.scheduled.length ? 'Reassessment window opened. The athlete was emailed.' : `Not opened: ${r.skipped.map((s) => s.reason).join(', ')}.`;
    }
    if (what === 'cancel') { await cancelSchedule(db, u.userId, String(form.get('scheduleId'))); msg = 'Reassessment window cancelled.'; }
    if (what === 'transfer') {
      await transferAthlete(db, u.userId, id, String(form.get('teamId')), String(form.get('date')));
      msg = 'Team changed. Earlier assessments stay with the earlier team.';
    }
    if (what === 'different' || what === 'link') {
      await resolveDuplicate(db, u.userId, String(form.get('reviewId')), what, String(form.get('reason') ?? ''));
      msg = what === 'link' ? 'Records linked. All history is kept.' : 'Marked as different people.';
    }
    if (what === 'grant') {
      await grantAccess(db, u.userId, id, String(form.get('staffUserId')), String(form.get('until')), String(form.get('reason') ?? ''));
      msg = 'Time-limited access granted and logged.';
    }
    if (what === 'revoke') { await revokeAccess(db, u.userId, String(form.get('grantId'))); msg = 'Access ended.'; }
  } catch (e) {
    redirect(`/athletes/${id}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`/athletes/${id}?msg=${encodeURIComponent(msg)}`);
}

export default async function AthleteDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const u = await requireUser('program_admin', 'health_support', 'coach', 'inst_leader');
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const h = await athleteHistory(db, u.userId, id);
  if (!h) notFound();
  const p = h.profile;
  const admin = p.is_admin;
  const staffDetail = u.roles.some((r) => r.role === 'program_admin' || r.role === 'health_support');
  const suggestion = admin ? await windowSuggestion(db, p.tenant_id) : null;

  const scored = h.instances.filter((i) => i.hgi_internal != null);
  const baseline = h.instances.find((i) => i.is_baseline && i.hgi_internal != null);
  const latest = scored[scored.length - 1];
  const analysis = h.analyses[h.analyses.length - 1];
  const changes = analysis ? h.findingChanges.filter((f) => f.change_analysis_id === analysis.change_analysis_id) : [];
  const openWindow = h.schedules.find((s) => s.outcome === 'Scheduled');
  const lastClosed = [...h.schedules].reverse().find((s) => s.outcome !== 'Scheduled');
  const currentTeams = h.affiliations.filter((a) => a.effective_end == null).map((a) => a.team).join(', ') || 'Individual';
  const curStrengths = latest ? h.strengths.filter((s) => s.instance_id === latest.instance_id).map((s) => s.title) : [];
  const by = (states: string[]) => changes.filter((c) => states.includes(c.state));
  const comparable = analysis?.comparison_status === 'Comparable';

  return (
    <main>
      <p><a href={admin ? '/athletes' : '/staff'}>&larr; {admin ? 'Athletes' : 'Overview'}</a></p>
      <h1>{p.first_name} {p.last_name} <span className="muted small">{p.athlete_code}</span></h1>
      <p className="muted">{p.email} · {p.institution} · {currentTeams}{p.institution_athlete_id ? ` · Student ID ${p.institution_athlete_id}` : ''}{p.status !== 'Active' ? ` · ${p.status}` : ''}</p>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}

      <div className="kpis">
        <div className="kpi"><div className="k">Baseline HGI</div><div className="v">{num(baseline?.hgi_display ?? null)}</div><div className="s">{baseline?.band ?? 'No baseline yet'}</div></div>
        <div className="kpi"><div className="k">Latest HGI</div><div className="v">{num(latest?.hgi_display ?? null)}</div><div className="s">{latest?.band ?? '-'}</div></div>
        <div className="kpi"><div className="k">Change since baseline</div>
          <div className="v">{analysis ? (comparable ? <span className={`delta ${Number(analysis.hgi_change) >= 0 ? 'up' : 'down'}`}>{signed(analysis.hgi_change)}</span> : '-') : '-'}</div>
          <div className="s">{analysis ? (comparable ? 'Internal values, not rounded' : 'Cross-version: review required') : 'No reassessment yet'}</div></div>
        <div className="kpi"><div className="k">Assessments</div><div className="v">{scored.length}</div><div className="s">{h.instances.length - scored.length} not scored</div></div>
        <div className="kpi"><div className="k">Reassessment</div>
          <div className="v" style={{ fontSize: 16, marginTop: 10 }}>{openWindow ? `Open until ${day(openWindow.target_end)}` : lastClosed?.outcome ?? 'Not scheduled'}</div></div>
      </div>

      <h2>HGI trend</h2>
      <div className="card">
        <TrendChart points={scored.map((i) => ({ label: day(i.submitted_at), hgi: Number(i.hgi_display), band: i.band ?? '', kind: i.is_baseline ? 'Baseline' : 'Reassessment' }))} />
        <p className="muted small" style={{ marginBottom: 0 }}>Dashed lines are the HGI band boundaries. Values are listed in the assessment history below.</p>
      </div>

      <h2>Reassessment summary</h2>
      {!analysis && <p className="muted">Shown after the first reassessment is scored.</p>}
      {analysis && !comparable && (
        <div className="notice draft">Cross-Version Comparison - Review Required. The baseline and the reassessment used different assessment versions and no approved mapping exists, so no change numbers or states are shown.</div>
      )}
      {analysis && comparable && (
        <div className="grid2">
          <div className="card">
            <h3>Overall change</h3>
            <p>HGI {num(analysis.hgi_baseline)} at baseline, {num(analysis.hgi_current)} now: <strong className={`delta ${Number(analysis.hgi_change) >= 0 ? 'up' : 'down'}`}>{signed(analysis.hgi_change)}</strong></p>
            <p className="muted small" style={{ marginBottom: 0 }}>Observed change only. It does not show what caused it.</p>
            <h3>Improvements</h3>
            {by(['Improved', 'Resolved']).length ? <ul className="summary-list">{by(['Improved', 'Resolved']).map((c) => <li key={c.rule_id}><span className={`state ${c.state}`}>{c.state}</span> {c.title}{c.is_contextual ? ' (environment / access)' : ''}</li>)}</ul> : <p className="muted">None.</p>}
            <h3>Strengths</h3>
            {curStrengths.length ? <ul className="summary-list">{curStrengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted">None listed.</p>}
          </div>
          <div className="card">
            <h3>Continuing priorities</h3>
            {by(['Persistent', 'Worsened']).length ? <ul className="summary-list">{by(['Persistent', 'Worsened']).map((c) => <li key={c.rule_id}><span className={`state ${c.state}`}>{c.state}</span> {c.title}{c.is_safety ? ' (safety)' : ''}</li>)}</ul> : <p className="muted">None.</p>}
            <h3>New findings</h3>
            {by(['New']).length ? <ul className="summary-list">{by(['New']).map((c) => <li key={c.rule_id}><span className="state New">New</span> {c.title}{c.is_safety ? ' (safety - stays first)' : ''}</li>)}</ul> : <p className="muted">None.</p>}
            <h3>Updated IHS</h3>
            <p style={{ marginBottom: 0 }}>The reassessment has its own Individualized Hydration Strategy, reviewed and approved the same way. The earlier IHS is kept.
              {admin && <> <a href={`/admin/review/${analysis.current_instance_id}`}>Open the reassessment review</a>.</>}</p>
          </div>
        </div>
      )}

      {analysis && comparable && staffDetail && (
        <>
          <h2>Finding changes</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Finding</th><th>State</th><th>Measure</th><th>Baseline</th><th>Now</th><th>Source</th><th>Priority class</th></tr></thead>
            <tbody>{changes.map((c) => (
              <tr key={c.rule_id}>
                <td>{c.title}<div className="cell-sub">{c.rule_id}{c.is_safety ? ' · safety' : ''}{c.is_contextual ? ' · contextual' : ''}</div></td>
                <td><span className={`state ${c.state}`}>{c.state}</span></td>
                <td className="small">{c.measure_label ?? 'present / absent'}</td>
                <td>{c.baseline_measure == null ? '-' : Number(c.baseline_measure).toFixed(c.measure_label?.endsWith('%') ? 1 : 0)}</td>
                <td>{c.current_measure == null ? '-' : Number(c.current_measure).toFixed(c.measure_label?.endsWith('%') ? 1 : 0)}</td>
                <td className="small">{c.source_class}</td>
                <td>{c.priority_class ?? '-'}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="muted small">Improved / Worsened need at least 10 percentage points for category findings, or one answer level for item findings (Milestone 3, Section 5.4, DRAFT). Completing an action item never changes a state.</p>
          <div className="grid2">
            <div>
              <h3>Category change</h3>
              <div className="table-wrap"><table>
                <thead><tr><th>Category</th><th>Baseline</th><th>Now</th><th>Change</th></tr></thead>
                <tbody>{analysis.category_changes.map((c) => (
                  <tr key={c.category}><td>{c.category}</td><td>{num(c.baseline)}</td><td>{num(c.current)}</td><td className={`delta ${c.changeDisplay.startsWith('-') ? 'down' : 'up'}`}>{c.changeDisplay}</td></tr>
                ))}</tbody>
              </table></div>
            </div>
            <div>
              <h3>Answers that changed</h3>
              {analysis.item_changes.length === 0 ? <p className="muted">None.</p> : (
                <div className="table-wrap"><table>
                  <thead><tr><th>Item</th><th>Baseline</th><th>Now</th></tr></thead>
                  <tbody>{analysis.item_changes.map((c) => <tr key={c.itemCode}><td>{c.itemCode}</td><td className="small">{c.baseline}</td><td className="small">{c.current}</td></tr>)}</tbody>
                </table></div>
              )}
              <h3>Category 7 context (outside HGI)</h3>
              {analysis.contextual_changes.length === 0 ? <p className="muted">No change.</p> : (
                <ul className="summary-list small">{analysis.contextual_changes.map((c) => <li key={c.itemCode}>{c.itemCode}: {c.baseline} &rarr; {c.current}</li>)}</ul>
              )}
            </div>
          </div>
        </>
      )}

      <h2>Assessment history</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Submitted</th><th>Type</th><th>Team at the time</th><th>Status</th><th>HGI</th><th>Band</th><th>Safety</th><th>Versions</th>{admin && <th aria-label="Open" />}</tr></thead>
        <tbody>
          {h.instances.length === 0 && <tr><td colSpan={9} className="muted">No assessments yet.</td></tr>}
          {h.instances.map((i) => (
            <tr key={i.instance_id}>
              <td>{day(i.submitted_at)}</td>
              <td>{i.is_baseline ? <span className="pill brand">Baseline</span> : i.schedule_id ? 'Reassessment' : 'Assessment'}</td>
              <td>{i.team ?? 'Individual'}</td>
              <td>{i.status}</td>
              <td>{num(i.hgi_display)}</td>
              <td>{i.band ?? '-'}</td>
              <td>{i.safety ? <span className="pill safety">{i.safety}</span> : '-'}</td>
              <td className="small">{i.asm_version_id} · {i.hga_version_id}</td>
              {admin && <td className="cell-actions">{i.hgi_internal != null && <a className="button secondary btn-sm" href={`/admin/review/${i.instance_id}`}>Open</a>}</td>}
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>Reassessment windows</h2>
      <p className="muted small">The target window is stored separately from the date the athlete actually completed the reassessment, and from the quarterly reporting dates.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Target window</th><th>Outcome</th><th>Completed on</th>{admin && <th aria-label="Actions" />}</tr></thead>
        <tbody>
          {h.schedules.length === 0 && <tr><td colSpan={4} className="muted">No reassessment scheduled.</td></tr>}
          {h.schedules.map((s) => (
            <tr key={s.schedule_id}>
              <td>{day(s.target_start)} - {day(s.target_end)}</td>
              <td>{s.outcome === OUTCOME_UNKNOWN ? <span className="pill warn">{s.outcome}</span> : s.outcome === 'Completed' ? <span className="pill ok">Completed</span> : s.outcome === 'Scheduled' ? <span className="pill brand">Open</span> : s.outcome}</td>
              <td>{day(s.submitted_at)}</td>
              {admin && <td className="cell-actions">{s.outcome === 'Scheduled' && !s.actual_instance_id && (
                <form action={act}><input type="hidden" name="participantId" value={id} /><input type="hidden" name="scheduleId" value={s.schedule_id} />
                  <button className="secondary btn-sm btn-danger-outline" name="what" value="cancel">Cancel</button></form>)}</td>}
            </tr>
          ))}
        </tbody>
      </table></div>
      {admin && !openWindow && baseline && suggestion && (
        <form action={act} className="card row">
          <input type="hidden" name="participantId" value={id} />
          <input type="hidden" name="tenantId" value={p.tenant_id} />
          <strong>Open a reassessment window</strong>
          <label className="row" style={{ margin: 0 }}>From <input type="date" name="start" defaultValue={suggestion.start} required style={{ width: 'auto' }} /></label>
          <label className="row" style={{ margin: 0 }}>To <input type="date" name="end" defaultValue={suggestion.end} required style={{ width: 'auto' }} /></label>
          <span className="muted small">Default: the next quarter ({suggestion.label}).</span>
          <button name="what" value="schedule">Open window</button>
        </form>
      )}

      <h2>Intervention history</h2>
      <p className="muted small">Hydration Action Items between assessments. Completing an item is recorded, but never counts as improvement on its own; only a reassessment shows change.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>From assessment</th><th>Finding</th><th>Pathway</th><th>Responsible</th><th>Reassessment target</th><th>Assigned</th><th>Status</th></tr></thead>
        <tbody>
          {h.interventions.length === 0 && <tr><td colSpan={7} className="muted">No released action items yet.</td></tr>}
          {h.interventions.map((a) => (
            <tr key={a.action_item_id} style={a.superseded ? { opacity: 0.55 } : undefined}>
              <td className="small">{(() => { const i = h.instances.find((x) => x.instance_id === a.instance_id); return i ? `${i.is_baseline ? 'Baseline' : 'Reassessment'} · ${day(i.submitted_at)}` : '-'; })()}</td>
              <td>{a.finding}{a.superseded && <div className="cell-sub">superseded by a correction</div>}</td>
              <td className="small">{PATHWAY[a.pathway]}</td>
              <td className="small">{a.audience.replace('_', ' ')}</td>
              <td className="small">{a.reassessment_target}</td>
              <td>{day(a.assigned_at)}</td>
              <td>{a.status === 'Completed / Implemented' ? <span className="pill ok">Completed {day(a.completed_at)}</span> : <span className="pill">{a.status}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <h2>Team history</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Team</th><th>From</th><th>To</th></tr></thead>
        <tbody>{h.affiliations.map((a) => <tr key={a.affiliation_id}><td>{a.team}</td><td>{day(a.effective_start)}</td><td>{a.effective_end ? day(a.effective_end) : 'Current'}</td></tr>)}</tbody>
      </table></div>
      {admin && h.teams.length > 1 && (
        <form action={act} className="card row">
          <input type="hidden" name="participantId" value={id} />
          <strong>Move to another team</strong>
          <select name="teamId" required defaultValue="" style={{ width: 'auto', flex: '0 1 220px' }} aria-label="New team">
            <option value="" disabled>Choose a team</option>
            {h.teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
          </select>
          <label className="row" style={{ margin: 0 }}>Effective <input type="date" name="date" required defaultValue={new Date().toISOString().slice(0, 10)} style={{ width: 'auto' }} /></label>
          <button className="secondary" name="what" value="transfer">Move</button>
          <span className="muted small">Earlier assessments stay with the earlier team.</span>
        </form>
      )}

      {admin && h.duplicates.length > 0 && (
        <>
          <h2>Possible duplicate</h2>
          {h.duplicates.map((d) => (
            <form action={act} className="card" key={d.duplicate_review_id}>
              <input type="hidden" name="participantId" value={id} />
              <input type="hidden" name="reviewId" value={d.duplicate_review_id} />
              <p><strong>{d.other_name}</strong> <span className="muted small">{d.other_code}</span> · {d.reason}. <a href={`/athletes/${d.other_id}`}>Open that record</a>.</p>
              <div className="row">
                <input type="text" name="reason" placeholder="Reason (required)" required style={{ flex: '1 1 260px', width: 'auto' }} aria-label="Reason" />
                <button className="secondary" name="what" value="different">Different people</button>
                <button name="what" value="link">Same person - link records</button>
              </div>
              <p className="muted small" style={{ marginBottom: 0 }}>Linking keeps every record and its history. The newer record&apos;s sign-in is turned off. Nothing is deleted.</p>
            </form>
          ))}
        </>
      )}

      {admin && (
        <>
          <h2>Individual access grants</h2>
          <p className="muted small">Coaches and college leaders never see individual results by default. WeCanH2O can grant one person time-limited access to this athlete. Every grant is logged.</p>
          {h.grants.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Staff</th><th>Until</th><th>Reason</th><th>Status</th><th aria-label="Actions" /></tr></thead>
              <tbody>{h.grants.map((g) => (
                <tr key={g.grant_id}>
                  <td>{g.staff}<div className="cell-sub">{g.email}</div></td><td>{day(g.valid_to)}</td><td className="small">{g.reason}</td>
                  <td>{g.active ? <span className="pill ok">Active</span> : <span className="pill">{g.revoked_at ? 'Ended' : 'Expired'}</span>}</td>
                  <td className="cell-actions">{g.active && (
                    <form action={act}><input type="hidden" name="participantId" value={id} /><input type="hidden" name="grantId" value={g.grant_id} />
                      <button className="secondary btn-sm btn-danger-outline" name="what" value="revoke">End access</button></form>)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {h.grantable.length > 0 && (
            <form action={act} className="card row">
              <input type="hidden" name="participantId" value={id} />
              <select name="staffUserId" required defaultValue="" style={{ width: 'auto', flex: '0 1 240px' }} aria-label="Staff member">
                <option value="" disabled>Choose a staff member</option>
                {h.grantable.map((s) => <option key={`${s.user_id}-${s.role}`} value={s.user_id}>{s.display_name} ({s.role.replace('_', ' ')})</option>)}
              </select>
              <label className="row" style={{ margin: 0 }}>Until <input type="date" name="until" required style={{ width: 'auto' }} /></label>
              <input type="text" name="reason" placeholder="Reason (required)" required style={{ flex: '1 1 220px', width: 'auto' }} aria-label="Reason" />
              <button className="secondary" name="what" value="grant">Grant access</button>
            </form>
          )}
        </>
      )}
    </main>
  );
}

import { notFound, redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import {
  ANNUAL, NARRATIVE_FIELDS, correctReport, fmtDate, getReport, regenerateReport, reportStep, saveNarrative,
} from '@/src/server/reporting';
import type { Metric } from '@/src/engine/aggregate';
import { periodLabel } from '@/src/server/report-pdf';

async function act(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const db = await getDb();
  const id = String(form.get('reportId'));
  const what = String(form.get('what'));
  const back = (r: { ok: boolean; message?: string }, ok: string, to = id) =>
    redirect(`/reports/formal/${to}?${r.ok ? `msg=${encodeURIComponent(ok)}` : `error=${encodeURIComponent(r.message ?? 'Not possible.')}`}`);
  if (what === 'save') {
    const narrative = Object.fromEntries([...form.entries()].filter(([k]) => k.startsWith('n_')).map(([k, v]) => [k.slice(2), String(v)]));
    return back(await saveNarrative(db, u.userId, id, narrative), 'Text saved.');
  }
  if (what === 'regenerate') return back(await regenerateReport(db, u.userId, id), 'Figures refreshed from the stored results.');
  if (what === 'correct') {
    const r = await correctReport(db, u.userId, id, String(form.get('reason') ?? ''));
    return back(r, 'Correction draft created. The released version stays unchanged until this one is released.', r.ok ? r.reportId : id);
  }
  const step = what as 'submit' | 'revise' | 'approve' | 'release';
  const labels = { submit: 'Sent for review.', revise: 'Returned for revision.', approve: 'Approved.', release: 'Released to the institution.' };
  return back(await reportStep(db, u.userId, id, step, String(form.get('note') ?? '')), labels[step]);
}

const LIFE = ['Draft', 'Under Review', 'Approved', 'Released'];
const show = (m: Metric) => (m.suppressed ? 'Withheld' : `${m.n} of ${m.d} (${m.pct ?? '0.0'}%)`);

export default async function FormalReport({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ msg?: string; error?: string }> }) {
  const u = await requireUser('program_admin', 'inst_leader');
  const { id } = await params;
  const sp = await searchParams;
  const r = await getReport(await getDb(), u.userId, id);
  if (!r) notFound();
  const d = r.content.data;
  const a = r.content.annual;
  const isAdmin = u.roles.some((x) => x.role === 'program_admin' && x.tenantId === r.tenant_id);
  const canExport = u.roles.some((x) => x.tenantId === r.tenant_id && x.canExport);
  const editable = isAdmin && ['Draft', 'Revision Required', 'Under Review'].includes(r.status);
  const step = r.status === 'Revision Required' ? 0 : r.status === 'Superseded' ? 4 : LIFE.indexOf(r.status);
  const fields = NARRATIVE_FIELDS[r.report_type];
  const s = d.summary;

  return (
    <main>
      <a href={`/reports/formal?tenant=${r.tenant_id}`} className="small">&larr; Formal reports</a>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">{r.report_number} · version {r.version}</div>
          <h1 style={{ marginBottom: 4 }}>{r.report_type}</h1>
          <p className="muted" style={{ margin: 0 }}>{d.tenant.name} · {periodLabel(d)}</p>
        </div>
        {canExport && <a className="button" href={`/reports/formal/${id}/pdf`}>Download PDF</a>}
      </div>
      {sp.msg && <div className="notice ok" style={{ marginTop: 14 }}>{sp.msg}</div>}
      {sp.error && <div className="notice error" style={{ marginTop: 14 }}>{sp.error}</div>}
      {r.status === 'Superseded' && <div className="notice warn" style={{ marginTop: 14 }}>This version was superseded by a correction. It is kept unchanged as history.</div>}
      {r.correction_reason && <div className="notice" style={{ marginTop: 14 }}>Corrected version. Reason: {r.correction_reason}</div>}
      {r.status === 'Revision Required' && r.review_note && <div className="notice warn" style={{ marginTop: 14 }}>Revision requested: {r.review_note}</div>}

      <div className="review-top" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="eyebrow" style={{ marginBottom: 10 }}>Report details</div>
          <table className="compact"><tbody>
            <tr><td>Program Year</td><td>{fmtDate(d.period.programYearStart)} - {fmtDate(d.period.programYearEnd)}</td></tr>
            <tr><td>Reporting period</td><td>{fmtDate(d.period.start)} - {fmtDate(d.period.end)}</td></tr>
            <tr><td>Generated</td><td>{fmtDate(r.generated_at)}{r.generated_by_name ? ` by ${r.generated_by_name}` : ''}</td></tr>
            <tr><td>Approved</td><td>{r.approved_at ? `${fmtDate(r.approved_at)} by ${r.approved_by_name}` : '-'}</td></tr>
            <tr><td>Rule versions</td><td>{r.rule_versions.join(', ') || '-'}</td></tr>
            <tr><td>Privacy threshold</td><td>{r.suppression_threshold} athletes</td></tr>
          </tbody></table>
        </div>
        <div className="card workflow-card">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Lifecycle</div>
          <ol className="wf-steps">
            {LIFE.map((label, i) => (
              <li key={label} className={i < step || r.status === 'Released' && i === 3 ? 'done' : i === step ? 'on' : ''}>
                <span className="wf-dot">{i < step || (r.status === 'Released' && i === 3) ? '✓' : i + 1}</span>
                <span className="wf-label">{label}</span>
              </li>
            ))}
          </ol>
          {isAdmin && (
            <form action={act} className="row" style={{ marginTop: 16 }}>
              <input type="hidden" name="reportId" value={id} />
              {['Draft', 'Revision Required'].includes(r.status) && <><button name="what" value="submit">Send for review</button>
                <button className="secondary" name="what" value="regenerate">Refresh figures</button></>}
              {r.status === 'Under Review' && <>
                <button name="what" value="approve">Approve</button>
                <input type="text" name="note" placeholder="What needs to change?" aria-label="Revision note" style={{ flex: 1, minWidth: 180 }} />
                <button className="secondary" name="what" value="revise">Return for revision</button></>}
              {r.status === 'Approved' && <button name="what" value="release">Release to the institution</button>}
              {r.status === 'Released' && <>
                <input type="text" name="reason" placeholder="Reason for correction" aria-label="Correction reason" style={{ flex: 1, minWidth: 180 }} />
                <button className="secondary" name="what" value="correct">Issue a correction</button></>}
            </form>
          )}
        </div>
      </div>

      {isAdmin && (
        <form action={act} className="card" style={{ marginTop: 18 }}>
          <input type="hidden" name="reportId" value={id} />
          <h2 style={{ marginTop: 0 }}>WeCanH2O reviewer text</h2>
          <p className="muted small">Written by WeCanH2O, never generated. Describe what was observed; do not claim the program caused a change.</p>
          {fields.map((f) => (
            <div key={f.key}>
              <label htmlFor={`n_${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
              <textarea id={`n_${f.key}`} name={`n_${f.key}`} rows={4} defaultValue={r.narrative[f.key] ?? ''} disabled={!editable} />
              <p className="muted small" style={{ marginTop: 4 }}>{f.help}</p>
            </div>
          ))}
          {editable && <button name="what" value="save">Save text</button>}
        </form>
      )}

      <h2>Report preview</h2>
      <div className="card">
        {r.report_type === ANNUAL && <><h3 style={{ marginTop: 0 }}>Executive Summary</h3><p>{r.narrative.executiveSummary || <span className="muted">To be completed by the WeCanH2O reviewer.</span>}</p></>}
        <h3 style={{ marginTop: r.report_type === ANNUAL ? undefined : 0 }}>{r.report_type === ANNUAL ? 'Program Scope and Participation' : '1. Program Snapshot'}</h3>
        <p>{d.participation.assessed} assessed of {d.participation.eligible} on team lists ({show(d.participation.completion)}) · {d.participation.baseline} baseline · {d.participation.reassessed} reassessed · Teams: {d.participation.teams.join(', ')}</p>
        <h3>{r.report_type === ANNUAL ? 'Annual HGI Overview' : '2. HGI Overview'}</h3>
        <p>{s.suppressed ? 'Withheld (privacy).' : `Average HGI ${s.hgiMean ?? '-'} · median ${s.hgiMedian ?? '-'} · ${s.bands.map((b) => `${b.band} ${b.athletes.n}`).join(' · ')}`}</p>
        <h3>{r.report_type === ANNUAL ? 'Hydration Gap Analysis' : '3. Hydration Gap Analysis'}</h3>
        <p>{s.suppressed ? 'Withheld (privacy).' : s.gaps.slice(0, 4).map((g) => `${g.title} (${show(g.athletes)})`).join(' · ') || 'None identified.'}</p>
        <h3>{r.report_type === ANNUAL ? 'Institutional / Environmental Findings' : '4. Institutional / Environmental Findings'}</h3>
        <p>{s.suppressed ? 'Withheld (privacy).' : s.institutional.map((g) => `${g.title} (${show(g.athletes)})`).join(' · ') || 'None identified.'}</p>
        <h3>{r.report_type === ANNUAL ? 'Education, IHS and Interventions' : '5. Education & Intervention Activity'}</h3>
        <p>{d.interventions.resultsReleased} results released · {d.interventions.itemsDelivered} action items delivered · completed {show(d.interventions.itemsCompleted)}</p>
        <h3>{r.report_type === ANNUAL ? 'Matched-Cohort Baseline-to-Year-End Change' : '6. Reassessment & Change'}</h3>
        <p>{a ? a.yearEndText : d.changeText} Outcome Unknown: {show(d.reassessment.outcomeUnknown)}.</p>
        <h3>{r.report_type === ANNUAL ? 'Safety & Support' : '7. Safety & Support Indicators'}</h3>
        <p>{s.safety.suppressed ? (s.safety.present ? `Present (fewer than ${d.threshold} athletes)` : 'Withheld') : show(s.safety)}. No individual symptom details are included.</p>
        {a && (<>
          <h3>Outcome dimensions</h3>
          <div className="grid2">
            {([['Athlete Hydration Intelligence', a.outcomes.athlete], ['Hydration Environment', a.outcomes.environment],
              ['Athletic Program Practices', a.outcomes.practices], ['Program Engagement / Delivery', a.outcomes.engagement]] as const).map(([t, rows]) => (
              <div key={t}><strong>{t}</strong><ul className="small">{rows.map((x) => <li key={x.label}>{x.label}: {x.value}</li>)}</ul></div>
            ))}
          </div>
        </>)}
        <h3>{r.report_type === ANNUAL ? 'Persistent and Emerging Priorities' : '8. Priority Opportunities'}</h3>
        <ol className="small">{d.priorities.map((p, i) => <li key={i}><strong>{p.title}</strong> ({p.kind}) - {p.detail}</li>)}</ol>
        {r.report_type !== ANNUAL && <><h3>9. Recommended Next-Quarter Actions</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.narrative.nextQuarterActions || <span className="muted">To be completed by the WeCanH2O reviewer.</span>}</p></>}
        {r.report_type === ANNUAL && <><h3>Next-Year Recommendations and Priorities</h3>
          <p style={{ whiteSpace: 'pre-wrap' }}>{r.narrative.nextYear || <span className="muted">To be completed by the WeCanH2O reviewer.</span>}</p></>}
        <p className="muted small" style={{ marginBottom: 0 }}>The PDF is the formal version, with every section in full.</p>
      </div>
    </main>
  );
}

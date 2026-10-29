import { redirect, notFound } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { decideRecommendation, markReviewed, releaseResults, reviewDetail } from '@/src/server/review';
import { correctResponse, correctionHistory } from '@/src/server/corrections';
import { changeFor } from '@/src/server/history';
import HgiRing from '@/src/ui/HgiRing';
import { A_ASM_1_0 } from '@/src/methodology/a-asm-1.0';
import { A_REC_1_0 } from '@/src/methodology/a-rec-1.0';
import { A_SCR_1_0 } from '@/src/methodology/a-scr-1.0';
import type { Pathway } from '@/src/methodology/types';

const PATHWAY = Object.fromEntries(A_REC_1_0.pathways.map((p) => [p.code, p.name]));
const CAT_NAMES = Object.fromEntries(A_SCR_1_0.categories.map((c) => [c.code, c.name]));
const PROFILE_TITLES = {
  circadianBaseline: 'Circadian Baseline',
  activityDemand: 'Activity Demand',
  triggersEnvironment: 'Hydration Triggers / Environment',
  individualFactors: 'Individual Factors',
} as const;
const fmt = (v: string | null | undefined, dp = 1) => (v == null ? '-' : Number(v).toFixed(dp));

const AUDIENCE: Record<string, string> = { athlete: 'Athlete', institution: 'Institution', health_support: 'Health support' };
// Short names for the six priority classes (Document #3, Section 5).
const PRIORITY: Record<number, string> = {
  1: 'Safety', 2: 'Institutional / access barrier', 3: 'High exposure + weak adaptation',
  4: 'Persistent gap', 5: 'Knowledge / intention-to-action', 6: 'Education / improvement',
};
const statusClass = (s: string) => s.split(/[ /]/)[0].toLowerCase();
const sourceClass = (s: string) =>
  s.startsWith('Safety') ? 'safety' : s.startsWith('Institutional') ? 'inst' : s.startsWith('Athlete') ? 'athlete' : s.includes('Contextual') ? 'context' : 'shared';
const inputLabel = (k: string) => (k === 'institution.heatSafetyProcedures' ? 'Team procedures' : k.replace('%', ' %').replace(/,/g, ', '));
const inputValue = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v == null ? 'blank' : String(v));

async function act(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const db = await getDb();
  const id = String(form.get('instanceId'));
  const what = String(form.get('what'));
  let msg = '';
  try {
    if (what === 'reviewed') { await markReviewed(db, u.userId, id); msg = 'Marked Reviewed.'; }
    if (what === 'correct') {
      const [itemCode, code] = String(form.get('answer') ?? '').split('|');
      await correctResponse(db, u.userId, { instanceId: id, itemCode, answer: itemCode === 'Q32A' ? code.split('+') : code, reason: String(form.get('reason') ?? '') });
      msg = 'Answer corrected. The record was revalidated and rescored; the earlier result is kept. Review it again before release.';
    }
    if (what === 'release') { await releaseResults(db, u.userId, id); msg = 'Results and IHS released to the athlete.'; }
    if (what === 'approve' || what === 'not_approve') {
      await decideRecommendation(db, u.userId, {
        recId: String(form.get('recId')),
        decision: what,
        pathway: (form.get('pathway') as Pathway) || undefined,
        note: String(form.get('note') ?? ''),
      });
      msg = what === 'approve' ? 'Recommendation approved.' : 'Recommendation not approved.';
    }
  } catch (e) {
    redirect(`/admin/review/${id}?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`/admin/review/${id}?msg=${encodeURIComponent(msg)}`);
}

export default async function ReviewDetail({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ msg?: string; error?: string }>;
}) {
  const u = await requireUser('program_admin');
  const { id } = await params;
  const sp = await searchParams;
  const db = await getDb();
  const d = await reviewDetail(db, u.userId, id);
  if (!d) notFound();
  const corrections = await correctionHistory(db, u.userId, id);
  const change = await changeFor(db, u.userId, id);
  const correctable = ['Complete / Scored', 'Reviewed', 'Released', 'Revalidated'].includes(d.header.status);
  const label = (code: string, c: string | null, cs: string[] | null, state: string) => {
    const i = A_ASM_1_0.items.find((x) => x.itemCode === code);
    if (state === 'blank') return 'blank';
    if (cs) return cs.map((v) => i?.options.find((o) => o.code === v)?.label ?? v).join('; ');
    return i?.options.find((o) => o.code === c)?.label ?? String(c);
  };
  const h = d.header;
  const findings = d.findings.filter((f) => f.finding_type !== 'strength');
  const strengths = d.findings.filter((f) => f.finding_type === 'strength');
  const undecided = d.recommendations.filter((r) => ['Suggested by Rules Engine', 'Reviewed'].includes(r.status)).length;
  // Workflow position: Scored -> Reviewed -> Approved -> Released.
  const WF = ['Scored', 'Reviewed', 'Approved', 'Released'];
  const wfStep = h.status === 'Released' ? 4 : h.status === 'Reviewed' ? (undecided === 0 && d.recommendations.length > 0 ? 2 : 1) : 0;
  const resp = new Map(d.responses.map((r) => [r.item_code, r]));
  const profile = d.run?.hydration_profile as Record<string, { item: string; answer: string }[]> | undefined;

  return (
    <main>
      <p><a href="/admin/review">&larr; Review queue</a></p>
      <h1>{h.first_name} {h.last_name} <span className="muted small">{h.athlete_code}</span></h1>
      <p className="muted">
        {h.team ?? 'No team'} · {h.institution} · Submitted {new Date(h.submitted_at).toLocaleString('en-US')} ·{' '}
        {h.is_baseline ? 'Baseline' : 'Reassessment'} · Status <strong>{h.status}</strong>
      </p>
      <p className="small muted">Rule versions: {h.asm_version_id} · {h.scr_version_id} · {h.hga_version_id} · {h.rec_version_id}</p>
      <div className="notice draft small">
        A-HGA-1.0 and A-REC-1.0 contain DRAFT trigger values and mapping (test fixture, not yet approved methodology).
        Recommendation wording is placeholder text until WeCanH2O supplies the Recommendation Library.
      </div>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}

      <div className="review-top">
        <div className="card hgi-card">
          {d.hgi?.hgi_display != null && <HgiRing value={Number(d.hgi.hgi_display)} size={118} id="reviewHgi" />}
          <div>
            <div className="eyebrow" style={{ marginBottom: 2 }}>Hydration Gap Index</div>
            <div className="hgi">{fmt(d.hgi?.hgi_display)}</div>
            {d.hgi?.band && <span className={`band-pill band-${d.hgi.band.split(' ')[0]}`}>{d.hgi.band}</span>}
            {d.hgi?.hgi_internal != null && (
              <div className="internal" title="The exact stored value is used for every calculation; it is shown here to 2 decimals.">
                Internal value <code>{Number(d.hgi.hgi_internal).toFixed(2)}</code>
              </div>
            )}
          </div>
        </div>
        <div className="card workflow-card">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Workflow</div>
          <ol className="wf-steps">
            {WF.map((label, i) => (
              <li key={label} className={i < wfStep ? 'done' : i === wfStep ? 'on' : ''}>
                <span className="wf-dot">{i < wfStep ? '\u2713' : i + 1}</span>
                <span className="wf-label">{label}</span>
              </li>
            ))}
          </ol>
          <form action={act} className="row" style={{ marginTop: 16 }}>
            <input type="hidden" name="instanceId" value={id} />
            {(h.status === 'Complete / Scored' || h.status === 'Revalidated') && <button name="what" value="reviewed">Mark Reviewed</button>}
            {h.status === 'Reviewed' && <button name="what" value="release" disabled={undecided > 0}>Release to athlete</button>}
            {h.status === 'Released' && <span className="pill ok">Released {h.released_at ? new Date(h.released_at).toLocaleString('en-US') : ''}</span>}
            {h.status === 'Reviewed' && undecided > 0 && <span className="small muted">{undecided} recommendation(s) still need a decision.</span>}
          </form>
        </div>
      </div>

      <h2>Recommendations (IHS)</h2>
      {d.recommendations.length === 0 && <p className="muted">No recommendations were suggested.</p>}
      {d.recommendations.map((r) => (
        <div className={`card rec-card${r.is_safety ? ' safety' : ''}`} key={r.rec_id}>
          <div className="rec-head">
            <span className={`rank-badge${r.is_safety ? ' safety' : ''}`}>{r.rank}</span>
            <div className="rec-title">
              <div className="rec-name">{r.title}</div>
              <div className="rec-tags">
                <code className="code">{r.rule_id}</code>
                <span className={`pill st-${statusClass(r.status)}`}>{r.status}</span>
                {r.is_safety && <span className="pill safety">Safety</span>}
              </div>
            </div>
          </div>
          <div className="rec-facts">
            <div className="fact"><div className="fact-k">Pathway</div><div className="fact-v"><span className="path-badge">{r.pathway}</span>{PATHWAY[r.pathway]}</div></div>
            <div className="fact"><div className="fact-k">Audience</div><div className="fact-v">{AUDIENCE[r.audience] ?? r.audience}</div></div>
            <div className="fact"><div className="fact-k">Reassessment target</div><div className="fact-v">{r.reassessment_target}</div></div>
          </div>
          <div className="rec-wording">
            <div className="fact-k">Wording {r.is_placeholder && <span className="pill warn tiny">Placeholder until the Recommendation Library is supplied</span>}</div>
            <div className="wording-grid">
              <div className="wording"><span>Athlete</span>{r.athlete_text}</div>
              <div className="wording"><span>Staff</span>{r.staff_text}</div>
              <div className="wording"><span>Institution</span>{r.institution_text}</div>
            </div>
          </div>
          {r.reviewer_note && <div className="rec-note"><span className="fact-k">Reviewer note</span> {r.reviewer_note}</div>}
          {r.status === 'Reviewed' && (
            <form action={act} className="rec-actions">
              <input type="hidden" name="instanceId" value={id} />
              <input type="hidden" name="recId" value={r.rec_id} />
              <select name="pathway" defaultValue={r.pathway} aria-label="Pathway">
                {[r.pathway, ...r.also_available].map((p) => <option key={p} value={p}>{p} - {PATHWAY[p]}</option>)}
              </select>
              <input type="text" name="note" placeholder="Reviewer note (optional)" aria-label="Reviewer note" />
              <button name="what" value="approve">Approve</button>
              <button className="secondary" name="what" value="not_approve">Not approve</button>
            </form>
          )}
        </div>
      ))}

      {change && (
        <>
          <h2>Change since baseline</h2>
          {change.comparison_status !== 'Comparable' ? (
            <div className="notice draft">Cross-Version Comparison - Review Required. No change numbers or states are shown without a WeCanH2O-approved version mapping.</div>
          ) : (
            <div className="card">
              <p>HGI {Number(change.hgi_baseline).toFixed(1)} at baseline, {Number(change.hgi_current).toFixed(1)} now:{' '}
                <strong className={`delta ${Number(change.hgi_change) >= 0 ? 'up' : 'down'}`}>{Number(change.hgi_change) >= 0 ? '+' : ''}{Number(change.hgi_change).toFixed(1)}</strong></p>
              <ul className="summary-list">
                {change.findings.map((f) => (
                  <li key={f.rule_id}><span className={`state ${f.state}`}>{f.state}</span> {f.title} <span className="muted small">{f.rule_id}{f.is_safety ? ' · safety' : ''}{f.is_contextual ? ' · contextual' : ''}</span></li>
                ))}
              </ul>
              <p className="muted small" style={{ marginBottom: 0 }}><a href={`/athletes/${change.participant_id}`}>Open the athlete&apos;s full history</a></p>
            </div>
          )}
        </>
      )}

      <h2>Hydration Gap Analysis</h2>
      {findings.length === 0 && <p className="muted">No gaps identified.</p>}
      <div className="finding-list">
        {findings.map((f) => (
          <div className={`finding${f.is_safety ? ' safety' : ''}`} key={f.finding_id}>
            <span className={`rank-badge${f.is_safety ? ' safety' : ''}`}>{f.rank}</span>
            <div className="finding-main">
              <div className="finding-title">{f.title}{f.is_safety && <span className="pill safety tiny">Safety</span>}</div>
              <div className="finding-meta">
                <code className="code">{f.rule_id}</code>
                <span className="muted small">{f.rule_version_id}</span>
                {f.source_class && <span className={`pill src-${sourceClass(f.source_class)}`}>{f.source_class}</span>}
              </div>
              {Object.keys(f.input_refs).length > 0 && (
                <div className="inputs">
                  <span className="fact-k">Triggered by</span>
                  {Object.entries(f.input_refs).map(([k, v]) => <span className="input-chip" key={k}>{inputLabel(k)} <b>{inputValue(v)}</b></span>)}
                </div>
              )}
            </div>
            <div className="finding-class" title={PRIORITY[f.priority_class ?? 0]}>
              <div className="fact-k">Priority</div>
              <div className={`class-badge c${f.priority_class}`}>{f.priority_class}</div>
              <div className="class-label">{PRIORITY[f.priority_class ?? 0]}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="strength-row">
        <span className="fact-k">Strengths</span>
        {strengths.length ? strengths.map((x) => <span className="pill ok" key={x.title}>{x.title.replace('Strength: ', '')}</span>) : <span className="muted">none</span>}
      </div>
      {d.run?.notes?.length ? <div className="notice">{d.run.notes.map((n) => <div key={n.ruleId}>{n.ruleId}: {n.note}</div>)}</div> : null}

      <h2>Category scores</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Category</th><th>Earned</th><th>Applicable max</th><th>Score</th><th>Internal</th><th>Category %</th><th>Status</th></tr></thead>
        <tbody>{d.categories.map((c) => (
          <tr key={c.category}>
            <td>{c.category} {CAT_NAMES[c.category]}</td>
            <td>{c.raw_score ?? '-'}</td>
            <td>{c.applicable_max ?? '-'}</td>
            <td>{fmt(c.score_display)}</td>
            <td className="small">{c.score_internal == null ? '-' : Number(c.score_internal).toFixed(2)}</td>
            <td>{c.percent_internal ? `${Number(c.percent_internal).toFixed(1)}%` : '-'}</td>
            <td>{c.status}</td>
          </tr>
        ))}</tbody>
      </table></div>

      {profile && (
        <>
          <h2>Hydration Profile</h2>
          <div className="profile-grid">
            {(Object.keys(PROFILE_TITLES) as (keyof typeof PROFILE_TITLES)[]).map((k) => (
              <div className="card profile-card" key={k}>
                <div className="profile-head">
                  <h3>{PROFILE_TITLES[k]}</h3>
                  <span className="profile-count">{profile[k].length}</span>
                </div>
                <ul className="profile-list">
                  {profile[k].map((a) => (
                    <li key={k + a.item}><span className="profile-q">{a.item}</span><span className="profile-a">{a.answer}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Corrections</h2>
      <p className="muted small">A correction keeps the original answer, the corrected answer, the reason, who made it and when. The record is then revalidated and rescored, and the earlier result and IHS are kept as superseded history.</p>
      {corrections.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>By</th><th>Item</th><th>Original</th><th>Corrected</th><th>Reason</th></tr></thead>
          <tbody>{corrections.map((c) => (
            <tr key={c.correction_id}>
              <td className="small">{new Date(c.corrected_at).toLocaleString('en-US')}</td><td>{c.corrected_by_name}</td><td>{c.item_code}</td>
              <td>{label(c.item_code, c.original_option_code, c.original_option_codes, c.original_state)}</td>
              <td>{label(c.item_code, c.corrected_option_code, c.corrected_option_codes, c.corrected_state)}</td>
              <td>{c.reason}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {correctable && (
        <form action={act} className="card">
          <input type="hidden" name="instanceId" value={id} />
          <label htmlFor="answer">Correct an answer</label>
          <select id="answer" name="answer" required defaultValue="">
            <option value="" disabled>Choose the question and the corrected answer</option>
            {A_ASM_1_0.items.map((i) => (
              <optgroup key={i.itemCode} label={`${i.itemCode} - ${i.prompt.slice(0, 70)}${i.prompt.length > 70 ? '...' : ''}`}>
                {i.options.map((o) => <option key={o.code} value={`${i.itemCode}|${o.code}`}>{i.itemCode}: {o.label}</option>)}
              </optgroup>
            ))}
          </select>
          <label htmlFor="reason">Reason (required)</label>
          <input id="reason" name="reason" type="text" required />
          <p><button name="what" value="correct">Save correction and revalidate</button></p>
        </form>
      )}

      <h2>Responses</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Answer</th><th>State</th><th>Points</th></tr></thead>
        <tbody>{A_ASM_1_0.items.map((i) => {
          const r = resp.get(i.itemCode);
          const label = i.multiSelect
            ? (r?.option_codes ?? []).map((c) => i.options.find((o) => o.code === c)?.label).join('; ')
            : i.options.find((o) => o.code === r?.option_code)?.label;
          return (
            <tr key={i.itemCode}>
              <td>{i.itemCode} <span className="muted small">{i.construct}</span></td>
              <td>{label || '-'}</td>
              <td>{r?.response_state ?? 'blank'}</td>
              <td>{r?.points ?? '-'}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </main>
  );
}

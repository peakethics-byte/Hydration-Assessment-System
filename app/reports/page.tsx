import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { dashboard, fmtDate, reportTenants, type ReportData } from '@/src/server/reporting';
import type { Metric } from '@/src/engine/aggregate';
import TrendChart from '@/src/ui/TrendChart';

type SP = { tenant?: string; period?: string; team?: string; type?: 'all' | 'baseline' | 'reassessment'; version?: string };

const show = (m: Metric) => (m.suppressed ? <span className="pill tiny" title="Withheld: group below the privacy threshold">Withheld</span>
  : <><strong>{m.n}</strong> <span className="muted">of {m.d}{m.pct != null ? ` (${m.pct}%)` : ''}</span></>);
const BAR = '#0ea5c4'; // same validated series colour as the athlete HGI trend

function Bars({ rows }: { rows: { label: string; m: Metric }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.m.n ?? 0));
  return (
    <div className="bars" role="table" aria-label="Distribution">
      {rows.map((r) => (
        <div className="bar-row" role="row" key={r.label} title={r.m.suppressed ? `${r.label}: withheld` : `${r.label}: ${r.m.n} of ${r.m.d} (${r.m.pct ?? '0.0'}%)`}>
          <span className="bar-label" role="cell">{r.label}</span>
          <span className="bar-track" role="cell">{!r.m.suppressed && (r.m.n ?? 0) > 0 && <span className="bar-fill" style={{ width: `${((r.m.n ?? 0) / max) * 100}%`, background: BAR }} />}</span>
          <span className="bar-value" role="cell">{r.m.suppressed ? 'Withheld' : `${r.m.n} (${r.m.pct ?? '0.0'}%)`}</span>
        </div>
      ))}
    </div>
  );
}

function Withheld({ d }: { d: ReportData }) {
  return <p className="notice">Withheld for privacy: fewer than {d.threshold} athletes in this view, or the figures could be worked out from another view. Only participation counts are shown.</p>;
}

export default async function Reports({ searchParams }: { searchParams: Promise<SP> }) {
  const u = await requireUser('program_admin', 'inst_leader', 'coach');
  const sp = await searchParams;
  const db = await getDb();
  const tenants = await reportTenants(db, u.userId);
  if (!tenants.length) redirect('/');
  const tenantId = tenants.find((t) => t.tenant_id === sp.tenant)?.tenant_id ?? tenants[0].tenant_id;
  const { data: d, periods, years, teams, scope } = await dashboard(db, u.userId, tenantId,
    { periodId: sp.period, teamId: sp.team, type: sp.type, version: sp.version });
  const s = d.summary;
  const yearOf = (id: string) => years.find((y) => y.program_year_id === id);
  const base = `tenant=${tenantId}&period=${d.period.id}${sp.team ? `&team=${sp.team}` : ''}${sp.type ? `&type=${sp.type}` : ''}${sp.version ? `&version=${sp.version}` : ''}`;

  return (
    <main>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div className="eyebrow">{d.labels.institution} dashboard</div>
          <h1 style={{ marginBottom: 4 }}>{d.tenant.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {d.period.type === 'Annual' ? 'Program Year' : `Quarter ${d.period.type.slice(1)}`}: {fmtDate(d.period.start)} to {fmtDate(d.period.end)}
            {scope.teamIds && <> · Your teams: {d.scope.teams?.join(', ')}</>}
          </p>
        </div>
        <div className="row">
          {(u.roles.some((r) => r.role === 'program_admin' || r.role === 'inst_leader')) && <a className="button secondary" href={`/reports/formal?tenant=${tenantId}`}>Formal reports</a>}
          {scope.role === 'admin' && <a className="button secondary" href={`/reports/settings?tenant=${tenantId}`}>Periods &amp; privacy</a>}
          {scope.canExport && <a className="button" href={`/reports/export?${base}`}>Export CSV</a>}
        </div>
      </div>

      <form className="card filters" method="get" style={{ marginTop: 18 }}>
        {tenants.length > 1 && (
          <select name="tenant" defaultValue={tenantId} aria-label={d.labels.institution}>
            {tenants.map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.display_name}</option>)}
          </select>
        )}
        <select name="period" defaultValue={d.period.id} aria-label="Reporting period">
          {periods.map((p) => {
            const y = yearOf(p.program_year_id);
            return <option key={p.period_id} value={p.period_id}>{p.period_type === 'Annual' ? 'Annual' : p.period_type} · {fmtDate(p.start_date)} - {fmtDate(p.end_date)}{y ? ` (PY ${y.program_start_date.slice(0, 4)})` : ''}</option>;
          })}
        </select>
        <select name="team" defaultValue={sp.team ?? ''} aria-label={d.labels.team}>
          <option value="">{scope.teamIds ? 'All my teams' : `All ${d.labels.team.toLowerCase()}s`}</option>
          {teams.map((t) => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
        </select>
        <select name="type" defaultValue={sp.type ?? 'all'} aria-label="Assessment type">
          <option value="all">Baseline and reassessment</option>
          <option value="baseline">Baseline only</option>
          <option value="reassessment">Reassessment only</option>
        </select>
        <select name="version" defaultValue={sp.version ?? ''} aria-label="Assessment version">
          <option value="">All assessment versions</option>
          <option value="A-ASM-1.0">A-ASM-1.0</option>
        </select>
        <div className="row"><button>Apply</button><a className="button secondary" href={`/reports?tenant=${tenantId}`}>Clear</a></div>
      </form>

      <section className="kpis">
        <div className="kpi"><div className="k">Assessed</div><div className="v">{d.participation.assessed}</div>
          <div className="s">of {d.participation.eligible} on team lists{d.participation.completion.pct ? ` · ${d.participation.completion.pct}%` : ''}</div></div>
        <div className="kpi"><div className="k">Average HGI</div><div className="v">{s.suppressed ? '-' : s.hgiMean ?? '-'}</div>
          <div className="s">{s.suppressed ? 'Withheld (privacy)' : `Median ${s.hgiMedian ?? '-'}`}</div></div>
        <div className="kpi"><div className="k">Reassessed</div><div className="v">{d.participation.reassessed}</div>
          <div className="s">Matched Cohort: {d.matched.suppressed ? 'withheld' : d.matched.n}</div></div>
        <div className="kpi"><div className="k">Safety / support</div>
          <div className="v">{s.safety.suppressed ? (s.safety.present ? 'Present' : '-') : s.safety.n ?? 0}</div>
          <div className="s">{s.safety.suppressed && s.safety.present ? `Fewer than ${d.threshold} athletes` : 'Aggregate only, no names'}</div></div>
      </section>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>HGI band distribution</h2>
          {s.suppressed ? <Withheld d={d} /> : s.assessed === 0 ? <p className="muted">No valid assessments in this period.</p>
            : <Bars rows={s.bands.map((b) => ({ label: b.band, m: b.athletes }))} />}
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Quarterly trend</h2>
          <TrendChart points={d.trend.filter((t) => !t.suppressed && t.hgiMean != null).map((t) => ({ label: t.period, hgi: Number(t.hgiMean), band: '', kind: `${t.assessed} assessed` }))} />
          <p className="muted small" style={{ marginBottom: 0 }}>
            {d.trend.map((t) => `${t.period}: ${t.suppressed ? 'withheld' : t.hgiMean ?? 'no data'} (${t.assessed})`).join(' · ')}
          </p>
        </div>
      </div>

      <h2>Hydration Gap Analysis</h2>
      {s.suppressed ? <Withheld d={d} /> : (
        <div className="grid2">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Category averages</h3>
            <table className="compact"><tbody>
              {s.categories.map((c) => (
                <tr key={c.code}><td>{c.code} {c.name}</td>
                  <td className="num">{c.contextual ? <span className="pill tiny" title="Contextual - never part of the HGI">Contextual</span> : c.meanPct != null ? `${c.meanPct}%` : '-'}</td></tr>
              ))}
            </tbody></table>
            <p className="muted small">Category 7 is contextual and outside the HGI. Band labels apply to the overall HGI only.</p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Top priority patterns</h3>
            <table className="compact"><tbody>
              {s.gaps.slice(0, 6).map((g) => <tr key={g.ruleId}><td>{g.title}{g.isSafety && <span className="pill safety tiny" style={{ marginLeft: 6 }}>Safety</span>}</td><td className="num">{show(g.athletes)}</td></tr>)}
              {!s.gaps.length && <tr><td className="muted">None identified.</td></tr>}
            </tbody></table>
            <h3>Strengths</h3>
            <div className="strength-row">{s.strengths.slice(0, 6).map((g) => <span className="pill ok" key={g.ruleId}>{g.title.replace('Strength: ', '')} · {g.athletes.n}</span>)}</div>
          </div>
        </div>
      )}

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Institutional &amp; environmental</h2>
          {s.suppressed ? <Withheld d={d} /> : (
            <table className="compact"><tbody>
              <tr><td>Category 2 average (water access &amp; environment)</td><td className="num">{s.categories.find((c) => c.code === 'C2')?.meanPct ?? '-'}%</td></tr>
              {s.institutional.map((g) => <tr key={g.ruleId}><td>{g.title}</td><td className="num">{show(g.athletes)}</td></tr>)}
            </tbody></table>
          )}
          <p className="muted small">Team procedures recorded: {d.procedures.exist} in place · {d.procedures.none} none · {d.procedures.unknown} not recorded</p>
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Interventions &amp; reassessment</h2>
          <table className="compact"><tbody>
            <tr><td>Results released to athletes</td><td className="num">{d.interventions.resultsReleased}</td></tr>
            <tr><td>Hydration Action Items delivered</td><td className="num">{d.interventions.itemsDelivered}</td></tr>
            <tr><td>Action items completed</td><td className="num">{show(d.interventions.itemsCompleted)}</td></tr>
            <tr><td>Reassessment windows due</td><td className="num">{d.reassessment.due}</td></tr>
            <tr><td>Completed</td><td className="num">{show(d.reassessment.completed)}</td></tr>
            <tr><td>Reassessment Not Completed / Outcome Unknown</td><td className="num">{show(d.reassessment.outcomeUnknown)}</td></tr>
          </tbody></table>
        </div>
      </div>

      <h2>Matched-cohort change</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>{d.changeText}</p>
        {!d.matched.suppressed && d.matched.n > 0 && (
          <table className="compact"><tbody>
            <tr><td>HGI higher / unchanged / lower</td><td className="num">{d.matched.higher.n} / {d.matched.same.n} / {d.matched.lower.n}</td></tr>
            {d.matched.states.map((st) => <tr key={st.state}><td>Athletes with a {st.state.toLowerCase()} gap</td><td className="num">{show(st.athletes)}</td></tr>)}
          </tbody></table>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>Matched Cohort = athletes with a comparable baseline and reassessment. The full population this period is {d.fullPopulation.assessed}; the two are never mixed.</p>
      </div>

      <h2>{d.labels.team} comparison</h2>
      <div className="table-wrap"><table className="users-table">
        <thead><tr><th>{d.labels.team}</th><th>Assessed</th><th>Average HGI</th><th>Safety / support</th><th>Most common gap</th></tr></thead>
        <tbody>
          {d.teams.map((t) => (
            <tr key={t.teamId}>
              <td className="cell-main">{t.name}</td>
              <td>{t.assessed}</td>
              <td>{t.suppressed ? <span className="pill tiny">Withheld</span> : t.hgiMean ?? '-'}</td>
              <td>{t.suppressed ? (t.safety.present ? 'Present' : <span className="pill tiny">Withheld</span>) : t.safety.present ? show(t.safety) : 'None'}</td>
              <td className="cell-sub-strong">{t.suppressed ? '-' : t.topGap ?? '-'}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <div className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>Priority opportunities</h2>
        {d.priorities.length === 0 ? <p className="muted">None for this view.</p> : (
          <ol className="summary-list">{d.priorities.map((p, i) => <li key={i}><span className={`pill tiny ${p.kind.startsWith('Safety') ? 'safety' : p.kind.startsWith('Inst') ? 'warn' : 'brand'}`}>{p.kind}</span> <strong>{p.title}</strong> <span className="muted">· {p.detail}</span></li>)}</ol>
        )}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Next report period ends {fmtDate(d.next.reportDate)}{d.next.reassessmentEnd ? ` · Next reassessment window ${fmtDate(d.next.reassessmentStart)} to ${fmtDate(d.next.reassessmentEnd)}` : ''}.
        </p>
      </div>

      <details className="card" style={{ marginTop: 18 }}>
        <summary>How these figures are calculated</summary>
        <ul className="small">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </details>
    </main>
  );
}

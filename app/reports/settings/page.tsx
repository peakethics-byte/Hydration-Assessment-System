import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { adjustPeriod, fmtDate, periodChanges, periodsFor, renewProgramYear, reportTenants, setThreshold, threshold } from '@/src/server/reporting';

async function act(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const db = await getDb();
  const tenantId = String(form.get('tenantId'));
  const what = String(form.get('what'));
  const go = (r: { ok: boolean; message?: string }, ok: string) =>
    redirect(`/reports/settings?tenant=${tenantId}&${r.ok ? `msg=${encodeURIComponent(ok)}` : `error=${encodeURIComponent(r.message ?? 'Not possible.')}`}`);
  if (what === 'adjust') {
    return go(await adjustPeriod(db, u.userId, { periodId: String(form.get('periodId')), start: String(form.get('start')), end: String(form.get('end')), reason: String(form.get('reason') ?? '') }),
      'Reporting dates changed. The original dates are kept.');
  }
  if (what === 'threshold') return go(await setThreshold(db, u.userId, tenantId, Number(form.get('threshold'))), 'Privacy threshold saved.');
  if (what === 'renew') { await renewProgramYear(db, u.userId, tenantId); return go({ ok: true }, 'Next Program Year created. Earlier periods and reports are unchanged.'); }
}

export default async function ReportSettings({ searchParams }: { searchParams: Promise<{ tenant?: string; msg?: string; error?: string }> }) {
  const u = await requireUser('program_admin');
  const sp = await searchParams;
  const db = await getDb();
  const tenants = (await reportTenants(db, u.userId)).filter((t) => u.roles.some((r) => r.role === 'program_admin' && r.tenantId === t.tenant_id));
  if (!tenants.length) redirect('/admin');
  const tenantId = tenants.find((t) => t.tenant_id === sp.tenant)?.tenant_id ?? tenants[0].tenant_id;
  const { years, periods } = await db.system((tx) => periodsFor(tx, tenantId));
  const k = await db.system((tx) => threshold(tx, tenantId));
  const changes = await periodChanges(db, u.userId, tenantId);

  return (
    <main>
      <a href={`/reports?tenant=${tenantId}`} className="small">&larr; Dashboard</a>
      <h1>Reporting periods &amp; privacy</h1>
      <p className="muted">{tenants.find((t) => t.tenant_id === tenantId)!.display_name}. Quarters are created automatically from the Program Start Date.</p>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}

      {years.map((y) => (
        <div className="card" key={y.program_year_id} style={{ marginBottom: 18 }}>
          <h2 style={{ marginTop: 0 }}>Program Year {fmtDate(y.program_start_date)} - {fmtDate(y.program_end_date)} <span className="pill tiny">{y.status}</span></h2>
          <div className="table-wrap"><table className="users-table">
            <thead><tr><th>Period</th><th>Start</th><th>End</th><th>Original dates</th><th>Change dates (reason required)</th></tr></thead>
            <tbody>
              {periods.filter((p) => p.program_year_id === y.program_year_id).map((p) => (
                <tr key={p.period_id}>
                  <td className="cell-main">{p.period_type}</td>
                  <td>{fmtDate(p.start_date)}</td>
                  <td>{fmtDate(p.end_date)}</td>
                  <td className="cell-sub">{p.original_start !== p.start_date || p.original_end !== p.end_date ? `${fmtDate(p.original_start)} - ${fmtDate(p.original_end)}` : 'Unchanged'}</td>
                  <td>
                    <form action={act} className="row" style={{ gap: 6 }}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="periodId" value={p.period_id} />
                      <input type="date" name="start" defaultValue={p.start_date} aria-label="Start date" style={{ width: 150 }} />
                      <input type="date" name="end" defaultValue={p.end_date} aria-label="End date" style={{ width: 150 }} />
                      <input type="text" name="reason" placeholder="Reason" aria-label="Reason" style={{ width: 160 }} />
                      <button className="secondary btn-sm" name="what" value="adjust">Save</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      ))}

      <div className="grid2">
        <form action={act} className="card">
          <input type="hidden" name="tenantId" value={tenantId} />
          <h2 style={{ marginTop: 0 }}>Renew the Program Year</h2>
          <p className="muted small">Creates the next Program Year and its four quarters from the day after the current year ends. Nothing in earlier years changes.</p>
          <button name="what" value="renew">Create next Program Year</button>
        </form>
        <form action={act} className="card">
          <input type="hidden" name="tenantId" value={tenantId} />
          <h2 style={{ marginTop: 0 }}>Privacy threshold</h2>
          <p className="muted small">Groups with fewer assessed athletes than this are withheld on the dashboard, in reports and in exports.
            <strong> DRAFT:</strong> the final value is pending privacy, legal and institutional review.</p>
          <label htmlFor="threshold">Minimum group size</label>
          <input id="threshold" name="threshold" type="number" min={1} max={100} defaultValue={k} style={{ maxWidth: 140 }} />
          <p><button name="what" value="threshold">Save</button></p>
        </form>
      </div>

      <h2>Date change history</h2>
      <div className="table-wrap"><table className="users-table">
        <thead><tr><th>Period</th><th>Original</th><th>Revised</th><th>Reason</th><th>Changed by</th></tr></thead>
        <tbody>
          {changes.length === 0 && <tr><td colSpan={5} className="muted">No changes.</td></tr>}
          {changes.map((c, i) => (
            <tr key={i}>
              <td className="cell-main">{c.period_type}</td>
              <td>{fmtDate(c.old_start)} - {fmtDate(c.old_end)}</td>
              <td>{fmtDate(c.new_start)} - {fmtDate(c.new_end)}</td>
              <td>{c.reason}</td>
              <td className="cell-sub">{c.display_name} · {new Date(c.changed_at).toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </main>
  );
}

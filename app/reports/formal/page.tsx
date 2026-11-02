import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { fmtDate, generateReport, listReports, periodsFor, reportTenants } from '@/src/server/reporting';

async function generate(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const tenantId = String(form.get('tenantId'));
  const r = await generateReport(await getDb(), u.userId, { tenantId, periodId: String(form.get('periodId')) });
  if (r.ok) redirect(`/reports/formal/${r.reportId}?msg=${encodeURIComponent('Draft generated from the stored results.')}`);
  if ('reportId' in r && r.reportId) redirect(`/reports/formal/${r.reportId}?error=${encodeURIComponent(r.message)}`);
  redirect(`/reports/formal?tenant=${tenantId}&error=${encodeURIComponent(r.message)}`);
}

const STATUS_PILL: Record<string, string> = { Draft: '', 'Under Review': 'brand', 'Revision Required': 'warn', Approved: 'brand', Released: 'ok', Superseded: '' };

export default async function FormalReports({ searchParams }: { searchParams: Promise<{ tenant?: string; error?: string }> }) {
  const u = await requireUser('program_admin', 'inst_leader');
  const sp = await searchParams;
  const db = await getDb();
  const tenants = await reportTenants(db, u.userId);
  if (!tenants.length) redirect('/');
  const tenantId = tenants.find((t) => t.tenant_id === sp.tenant)?.tenant_id ?? tenants[0].tenant_id;
  const isAdmin = u.roles.some((r) => r.role === 'program_admin' && r.tenantId === tenantId);
  const reports = await listReports(db, u.userId, tenantId);
  const { periods, years } = await db.system((tx) => periodsFor(tx, tenantId));
  const tenant = tenants.find((t) => t.tenant_id === tenantId)!;

  return (
    <main>
      <a href={`/reports?tenant=${tenantId}`} className="small">&larr; Dashboard</a>
      <h1>Formal reports</h1>
      <p className="muted">{tenant.display_name} · Quarterly Hydration Gap Reports and Annual Hydration Intelligence Impact Reports.
        {isAdmin ? ' Each report is generated from the stored results, reviewed and approved by WeCanH2O, then released.' : ' Only released reports are shown.'}</p>
      {sp.error && <div className="notice error">{sp.error}</div>}
      {tenants.length > 1 && (
        <form method="get" className="row" style={{ marginBottom: 14 }}>
          <select name="tenant" defaultValue={tenantId} aria-label="Institution">{tenants.map((t) => <option key={t.tenant_id} value={t.tenant_id}>{t.display_name}</option>)}</select>
          <button className="secondary">Show</button>
        </form>
      )}

      {isAdmin && (
        <form action={generate} className="card row" style={{ alignItems: 'flex-end', marginBottom: 18 }}>
          <input type="hidden" name="tenantId" value={tenantId} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <label htmlFor="periodId">Generate a report for</label>
            <select id="periodId" name="periodId" required>
              {years.map((y) => (
                <optgroup key={y.program_year_id} label={`Program Year ${fmtDate(y.program_start_date)} - ${fmtDate(y.program_end_date)}`}>
                  {periods.filter((p) => p.program_year_id === y.program_year_id).map((p) => (
                    <option key={p.period_id} value={p.period_id}>
                      {p.period_type === 'Annual' ? 'Annual Impact Report' : `${p.period_type} Quarterly Report`} · {fmtDate(p.start_date)} - {fmtDate(p.end_date)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <button>Generate draft</button>
        </form>
      )}

      <div className="table-wrap"><table className="users-table">
        <thead><tr><th>Report</th><th>Period</th><th>Version</th><th>Status</th><th>Generated</th><th aria-label="Open" /></tr></thead>
        <tbody>
          {reports.length === 0 && <tr><td colSpan={6} className="muted">No reports yet.</td></tr>}
          {reports.map((r) => (
            <tr key={r.report_id}>
              <td><div className="cell-main">{r.report_type}</div><div className="cell-sub">{r.report_number}</div></td>
              <td className="cell-sub-strong">{r.content.data.period.type} · {fmtDate(r.content.data.period.start)} - {fmtDate(r.content.data.period.end)}</td>
              <td>v{r.version}</td>
              <td><span className={`pill ${STATUS_PILL[r.status] ?? ''}`}>{r.status}</span></td>
              <td className="cell-sub">{fmtDate(r.generated_at)}</td>
              <td><a className="button secondary btn-sm" href={`/reports/formal/${r.report_id}`}>Open</a></td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </main>
  );
}

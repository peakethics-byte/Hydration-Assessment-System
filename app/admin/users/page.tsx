import { Fragment } from 'react';
import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requireUser } from '@/src/server/session';
import { adminScopes, userList } from '@/src/server/admin';
import { ROLE_LABELS, type Role } from '@/src/server/auth';
import { addStaff, endStaffRole, resendSetupLink, STAFF_ROLE_LABELS, STAFF_ROLES, type StaffRole } from '@/src/server/accounts';

// Short role names for the table; the full governing name shows on hover.
const SHORT_ROLE: Record<string, string> = {
  program_admin: 'Program Admin',
  health_support: 'Athletic Trainer',
  coach: 'Coach',
  inst_leader: 'Leadership',
  athlete: 'Athlete',
  tech_admin: 'Technical Admin',
};

async function add(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const scope = String(form.get('scope') ?? ''); // "tenantId" or "tenantId|teamId"
  const [tenantId, teamId] = scope.split('|');
  let msg: string;
  try {
    const r = await addStaff(await getDb(), u.userId, {
      tenantId,
      teamId: teamId || undefined,
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      role: String(form.get('role') ?? '') as StaffRole,
      canExport: form.get('canExport') === 'on',
    });
    msg = r.newAccount ? 'Staff member added. An email with a link to set their password was sent.' : 'Role added to the existing account. They were notified by email.';
  } catch (e) {
    redirect(`/admin/users?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`/admin/users?msg=${encodeURIComponent(msg)}`);
}

async function act(form: FormData) {
  'use server';
  const u = await requireUser('program_admin');
  const db = await getDb();
  let msg = '';
  try {
    if (form.get('what') === 'resend') {
      await resendSetupLink(db, u.userId, String(form.get('userId')), String(form.get('tenantId')));
      msg = 'A new password-setup link was emailed.';
    } else {
      await endStaffRole(db, u.userId, String(form.get('roleAssignmentId')));
      msg = 'Access ended. The history is kept in the audit log.';
    }
  } catch (e) {
    redirect(`/admin/users?error=${encodeURIComponent((e as Error).message)}`);
  }
  redirect(`/admin/users?msg=${encodeURIComponent(msg)}`);
}

export default async function Users({ searchParams }: { searchParams: Promise<{ role?: string; q?: string; msg?: string; error?: string }> }) {
  const u = await requireUser('program_admin');
  const sp = await searchParams;
  const db = await getDb();
  const [all, scopes] = await Promise.all([userList(db, u.userId), adminScopes(db, u.userId)]);
  const q = (sp.q ?? '').trim().toLowerCase();
  const rows = all.filter((r) => (!sp.role || r.role === sp.role)
    && (!q || [r.display_name, r.email, r.athlete_code ?? '', r.teams ?? ''].some((v) => v.toLowerCase().includes(q))));
  const counts = all.reduce<Record<string, number>>((m, r) => ({ ...m, [r.role]: (m[r.role] ?? 0) + 1 }), {});
  const institutions = scopes.tenants.filter((t) => t.tenant_kind === 'institution');
  // One heading per institution instead of repeating it on every row.
  const groups = [...rows.reduce((m, r) => m.set(r.institution, [...(m.get(r.institution) ?? []), r]), new Map<string, typeof rows>())];

  return (
    <main>
      <h1>Users</h1>
      <p className="muted">Everyone with access to your institutions, and their role. Add staff here; athletes join through the team list, and individual users through Requests.</p>
      {sp.msg && <div className="notice ok">{sp.msg}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}

      <details className="card" open={Boolean(sp.error)}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>+ Add a staff member</summary>
        <form action={add}>
          <div className="grid2" style={{ marginTop: 8 }}>
            <div>
              <label htmlFor="name">Full name</label>
              <input id="name" name="name" type="text" required />
            </div>
            <div>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" required />
            </div>
            <div>
              <label htmlFor="role">Role</label>
              <select id="role" name="role" required defaultValue="">
                <option value="" disabled>Choose a role</option>
                {STAFF_ROLES.map((r) => <option key={r} value={r}>{STAFF_ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="scope">Institution and team</label>
              <select id="scope" name="scope" required defaultValue="">
                <option value="" disabled>Choose where they work</option>
                {institutions.map((t) => (
                  <optgroup key={t.tenant_id} label={t.display_name}>
                    <option value={t.tenant_id}>{t.display_name} - whole institution</option>
                    {scopes.teams.filter((tm) => tm.tenant_id === t.tenant_id).map((tm) => (
                      <option key={tm.team_id} value={`${t.tenant_id}|${tm.team_id}`}>{t.display_name} - {tm.name} only</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <label className="row" style={{ fontWeight: 400 }}>
            <input type="checkbox" name="canExport" /> Allow export (PDF / CSV). Viewing never includes export.
          </label>
          <p className="muted small">
            Coach: choose one team. Athletic trainer: one team or the whole institution. Program Administrator and Institution Leadership: whole institution.
            New staff get an email to set their own password; you never see or type it.
          </p>
          <p><button type="submit">Add staff member</button></p>
        </form>
      </details>

      <form className="card row" method="get">
        <input type="text" name="q" defaultValue={sp.q ?? ''} placeholder="Search name, email, Athlete ID or team" style={{ flex: '1 1 260px', width: 'auto' }} aria-label="Search" />
        <select name="role" defaultValue={sp.role ?? ''} style={{ width: 'auto' }} aria-label="Role">
          <option value="">All roles ({all.length})</option>
          {(Object.keys(ROLE_LABELS) as Role[]).filter((r) => counts[r]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]} ({counts[r]})</option>)}
        </select>
        <button className="secondary">Filter</button>
      </form>

      <div className="table-wrap"><table className="users-table">
        <thead><tr><th>Person</th><th>Role</th><th>Team / scope</th><th>Athlete ID</th><th>Status</th><th aria-label="Actions" /></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={6} className="muted">No users match.</td></tr>}
          {groups.map(([institution, people]) => (
            <Fragment key={institution}>
              <tr className="group-row">
                <td colSpan={6}>{institution} <span className="muted">· {people.length} {people.length === 1 ? 'person' : 'people'}</span></td>
              </tr>
              {people.map((r) => (
                <tr key={r.role_assignment_id}>
                  <td>
                    <div className="cell-main">{r.display_name}</div>
                    <div className="cell-sub">{r.email}</div>
                  </td>
                  <td>
                    <span className={`pill role-${r.role}`} title={ROLE_LABELS[r.role as Role] ?? r.role}>{SHORT_ROLE[r.role] ?? r.role}</span>
                    {r.can_export && <span className="pill tiny" title="Allowed to export PDF / CSV">Export</span>}
                  </td>
                  <td className="cell-sub-strong">
                    {r.role === 'athlete' ? (r.teams ?? 'Individual') : r.scope_label ?? (r.scope_type === 'tenant' ? 'Whole institution' : r.scope_type)}
                  </td>
                  <td>{r.athlete_code ? <code className="code">{r.athlete_code}</code> : <span className="muted">-</span>}</td>
                  <td>
                    {r.setup_pending
                      ? <span className="pill warn" title="Invited - password not set yet">Invited</span>
                      : <span className={`pill${r.status === 'Active' ? ' ok' : ''}`}>{r.status}</span>}
                  </td>
                  <td className="cell-actions">
                    {r.role !== 'athlete' && !(r.user_id === u.userId && r.role === 'program_admin') && (
                      <form action={act} className="actions">
                        <input type="hidden" name="userId" value={r.user_id} />
                        <input type="hidden" name="tenantId" value={r.tenant_id} />
                        <input type="hidden" name="roleAssignmentId" value={r.role_assignment_id} />
                        {r.setup_pending && <button className="secondary btn-sm" name="what" value="resend">Resend link</button>}
                        <button className="secondary btn-sm btn-danger-outline" name="what" value="end">End access</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table></div>
      <p className="muted small" style={{ marginTop: 12 }}>
        Date of birth and mother&apos;s maiden name are not shown. They are kept only for matching later assessments; the maiden name is stored as a code that cannot be read back.
      </p>
    </main>
  );
}

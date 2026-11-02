import type { Metadata } from 'next';
import './globals.css';
import { currentUser, homeFor } from '@/src/server/session';
import { ROLE_LABELS } from '@/src/server/auth';

export const metadata: Metadata = { title: 'Structured Hydration Assessment System', description: 'WeCanH2O Structured Hydration Assessment' };
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const u = await currentUser();
  const roles = new Set(u?.roles.map((r) => r.role));
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="bar">
            <a className="brand" href={u ? homeFor(u) : '/'}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <span className="logo-plate"><img className="logo-full" src="/logo-full.png" alt="SipLogic" width={117} height={40} /></span>
            </a>
            <nav>
              {roles.has('athlete') && <><a href="/athlete">My assessment</a><a href="/athlete/results">My results</a><a href="/athlete/history">My history</a></>}
              {roles.has('program_admin') && <><a href="/admin">Teams &amp; sign-up</a><a href="/admin/review">Review queue</a><a href="/athletes">Athletes</a><a href="/reports">Reports</a><a href="/admin/users">Users</a><a href="/admin/requests">Requests</a><a href="/admin/audit">Audit log</a></>}
              {u && !roles.has('athlete') && !roles.has('program_admin') && <a href="/staff">Overview</a>}
              {(roles.has('inst_leader') || roles.has('coach')) && !roles.has('program_admin') && <a href="/reports">Reports</a>}
              {roles.has('health_support') && !roles.has('program_admin') && <a href="/athletes">Athletes</a>}
            </nav>
            <span className="who">
              {u ? (
                <>
                  <span><span className="name">{u.displayName}</span> · {u.roles.map((r) => ROLE_LABELS[r.role]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</span>
                  <a className="button secondary" style={{ padding: '6px 14px', fontSize: 13 }} href="/logout">Sign out</a>
                </>
              ) : <a className="button" style={{ padding: '7px 16px', fontSize: 14 }} href="/login">Sign in</a>}
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}

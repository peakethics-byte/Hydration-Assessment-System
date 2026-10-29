import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { requestAccess } from '@/src/server/accounts';

// Individual users: people who are not on a college team list ask WeCanH2O for access.
async function submit(form: FormData) {
  'use server';
  const r = await requestAccess(await getDb(), {
    firstName: String(form.get('firstName') ?? ''),
    lastName: String(form.get('lastName') ?? ''),
    email: String(form.get('email') ?? ''),
  });
  redirect(`/request-access?${r.ok ? 'ok' : 'error'}=${encodeURIComponent(r.message)}`);
}

export default async function RequestAccessPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="narrow auth">
      <h1>Individual access</h1>
      <p className="muted">Not on a college team list? Ask WeCanH2O for individual access. After approval you will get an email with a sign-up link. Your results are private to you.</p>
      {sp.ok && <div className="notice ok">{sp.ok}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}
      {!sp.ok && (
        <form action={submit} className="card">
          <label htmlFor="firstName">First name</label>
          <input id="firstName" name="firstName" type="text" autoComplete="given-name" required />
          <label htmlFor="lastName">Last name</label>
          <input id="lastName" name="lastName" type="text" autoComplete="family-name" required />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <p><button type="submit">Request access</button></p>
        </form>
      )}
      <p className="muted small">On a college team? <a href="/signup">Use athlete sign-up instead</a>.</p>
    </main>
  );
}

import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { websiteSignup } from '@/src/server/roster';

// Way 1: website sign-up. The email is checked against the team list the college sent.
async function signUp(form: FormData) {
  'use server';
  const r = await websiteSignup(await getDb(), {
    firstName: String(form.get('firstName') ?? ''),
    lastName: String(form.get('lastName') ?? ''),
    email: String(form.get('email') ?? ''),
  });
  redirect(`/signup?${r.ok ? 'ok' : 'error'}=${encodeURIComponent(r.message)}`);
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="narrow auth">
      <h1>Athlete sign-up</h1>
      <p className="muted">Enter your name and the email your college put on your team list.</p>
      {sp.ok && <div className="notice ok">{sp.ok}</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}
      {!sp.ok && (
        <form action={signUp} className="card">
          <label htmlFor="firstName">First name</label>
          <input id="firstName" name="firstName" type="text" autoComplete="given-name" required />
          <label htmlFor="lastName">Last name</label>
          <input id="lastName" name="lastName" type="text" autoComplete="family-name" required />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <p><button type="submit">Check my team list</button></p>
        </form>
      )}
      <p className="muted small">Not on a college team? <a href="/request-access">Request individual access</a>.</p>
    </main>
  );
}

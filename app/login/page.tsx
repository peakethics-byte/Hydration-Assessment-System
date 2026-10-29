import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getDb } from '@/src/server/db';
import { login } from '@/src/server/auth';
import { SESSION_COOKIE } from '@/src/server/session';

async function signIn(form: FormData) {
  'use server';
  const r = await login(await getDb(), String(form.get('email') ?? ''), String(form.get('password') ?? ''));
  if (!r.ok) redirect(`/login?error=${encodeURIComponent(r.message)}`);
  (await cookies()).set(SESSION_COOKIE, r.sessionToken, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 3600 });
  redirect('/');
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; registered?: string }> }) {
  const sp = await searchParams;
  return (
    <main className="narrow auth">
      <h1>Sign in</h1>
      {sp.registered && <div className="notice ok">Your account is ready. Please sign in.</div>}
      {sp.error && <div className="notice error">{sp.error}</div>}
      <form action={signIn} className="card">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <p><button type="submit">Sign in</button></p>
      </form>
      <p className="muted small">New athlete? <a href="/signup">Sign up with the email on your team list</a>.</p>
    </main>
  );
}

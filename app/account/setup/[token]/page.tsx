import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { completeSetup, setupInfo } from '@/src/server/accounts';

// Staff added by a WeCanH2O Program Administrator choose their password here.
async function setup(form: FormData) {
  'use server';
  const token = String(form.get('token'));
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) redirect(`/account/setup/${token}?error=${encodeURIComponent('The two passwords do not match.')}`);
  const r = await completeSetup(await getDb(), token, password);
  if (!r.ok) redirect(`/account/setup/${token}?error=${encodeURIComponent(r.message)}`);
  redirect('/login?registered=1');
}

export default async function SetupPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const info = await setupInfo(await getDb(), token);
  if (!info.ok) return <main className="narrow auth"><h1>Account link</h1><div className="notice error">{info.message}</div></main>;
  return (
    <main className="narrow auth">
      <h1>Set up your account</h1>
      <p>{info.name} · {info.institution}</p>
      {sp.error && <div className="notice error">{sp.error}</div>}
      <form action={setup} className="card">
        <input type="hidden" name="token" value={token} />
        <label>Email</label>
        <input type="email" value={info.email} readOnly />
        <label htmlFor="password">Choose a password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <p className="muted small">At least 10 characters, with a letter and a number.</p>
        <label htmlFor="confirm">Type the password again</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        <p><button type="submit">Save password</button></p>
      </form>
    </main>
  );
}

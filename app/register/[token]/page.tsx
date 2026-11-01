import { redirect } from 'next/navigation';
import { getDb } from '@/src/server/db';
import { completeRegistration, registrationInfo } from '@/src/server/roster';

// Both sign-up ways end here: the emailed link sets the password and the identity-matching details.
async function register(form: FormData) {
  'use server';
  const token = String(form.get('token'));
  if (String(form.get('password') ?? '') !== String(form.get('confirm') ?? '')) redirect(`/register/${token}?error=${encodeURIComponent('The two passwords do not match.')}`);
  const r = await completeRegistration(await getDb(), token, {
    password: String(form.get('password') ?? ''),
    dateOfBirth: String(form.get('dateOfBirth') ?? ''),
    mothersMaidenName: String(form.get('mothersMaidenName') ?? ''),
  });
  if (!r.ok) redirect(`/register/${token}?error=${encodeURIComponent(r.message)}`);
  redirect('/login?registered=1');
}

export default async function RegisterPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const info = await registrationInfo(await getDb(), token);
  if (!info.ok) return <main className="narrow auth"><h1>Sign-up link</h1><div className="notice error">{info.message}</div></main>;
  return (
    <main className="narrow auth">
      <h1>Finish signing up</h1>
      <p>{info.firstName} {info.lastName} · {info.team ? `${info.team} · ${info.institution}` : 'Individual user'}</p>
      {sp.error && <div className="notice error">{sp.error}</div>}
      <form action={register} className="card">
        <input type="hidden" name="token" value={token} />
        <label>Email</label>
        <input type="email" value={info.email} readOnly />
        <label htmlFor="password">Choose a password</label>
        <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        <p className="muted small">At least 10 characters, with a letter and a number.</p>
        <label htmlFor="confirm">Type the password again</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        <label htmlFor="dateOfBirth">Date of birth</label>
        <input id="dateOfBirth" name="dateOfBirth" type="date" required />
        <label htmlFor="mothersMaidenName">Mother&apos;s maiden name</label>
        <input id="mothersMaidenName" name="mothersMaidenName" type="text" autoComplete="off" required />
        <p className="muted small">
          We use your date of birth and your mother&apos;s maiden name only to match your later assessments to you, because emails can change.
          Your mother&apos;s maiden name is stored in a protected, coded form that cannot be read back.
        </p>
        <p><button type="submit">Create my account</button></p>
      </form>
    </main>
  );
}

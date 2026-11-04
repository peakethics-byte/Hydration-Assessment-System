import { getDb } from '@/src/server/db';
import { acknowledge, ackStatus, athleteHome } from '@/src/server/assessment';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/src/server/session';
import { longDate } from '@/src/domain/format';

const MESSAGE: Record<string, string> = {
  'Not Started': 'Your Structured Hydration Assessment is ready to start.',
  'In Progress': 'You have started your assessment. Your answers are saved.',
  'Complete / Scored': 'Thank you. Your assessment was submitted. WeCanH2O will review it before your results are shared with you.',
  Reviewed: 'Thank you. Your assessment was submitted. WeCanH2O is reviewing it.',
  Released: 'Your results are ready.',
  'Correction Required': 'Your assessment is being updated by WeCanH2O.',
  Revalidated: 'Your assessment was updated. WeCanH2O is reviewing it.',
};

async function ack(form: FormData) {
  'use server';
  const u = await requireUser('athlete');
  await acknowledge(await getDb(), u.userId, String(form.get('version')));
  revalidatePath('/athlete');
}

export default async function AthleteHome() {
  const u = await requireUser('athlete');
  const db = await getDb();
  const { instance, profile, window } = await athleteHome(db, u.userId);
  const a = await ackStatus(db, u.userId);
  const needsAck = a.required && !a.acknowledged;
  const reassessmentOpen = Boolean(window) && instance != null && !['Not Started', 'In Progress'].includes(instance.status);
  const status = instance?.status ?? 'Not Started';
  const until = window ? longDate(window.target_end) : '';
  return (
    <main className="narrow">
      <h1>Hello{profile ? `, ${profile.first_name}` : ''}</h1>
      <p className="muted small">Athlete ID {profile?.athlete_code}</p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Structured Hydration Assessment</h2>
        <p>{MESSAGE[status] ?? status}</p>
        {reassessmentOpen && (
          <div className="notice">
            <strong>Your reassessment is open until {until}.</strong> Take the Structured Hydration Assessment again so WeCanH2O can see what has changed.
            <div style={{ marginTop: 10 }}><a className="button" href="/athlete/assessment?part=1">Start my reassessment</a></div>
          </div>
        )}
        {instance?.draft_expires_at && status === 'In Progress' && (
          <p className="muted small">Please submit by {longDate(instance.draft_expires_at)}. Unsubmitted answers are kept for 14 days.</p>
        )}
        {needsAck && a.required && (
          <form action={ack} className="notice">
            <input type="hidden" name="version" value={a.documentVersionId} />
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{a.body}</p>
            <button>I acknowledge</button>
          </form>
        )}
        {!needsAck && (status === 'Not Started' || status === 'In Progress') && (
          <a className="button" href="/athlete/assessment?part=1">{status === 'Not Started' ? 'Start the assessment' : 'Continue'}</a>
        )}
        {status === 'Released' && <a className="button" href="/athlete/results">See my results</a>}
      </div>
    </main>
  );
}

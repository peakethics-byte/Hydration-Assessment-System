import { redirect } from 'next/navigation';
import { currentUser, homeFor } from '@/src/server/session';

export default async function Home() {
  const u = await currentUser();
  if (u) redirect(homeFor(u));
  return (
    <main>
      <section className="hero">
        <div className="eyebrow">WeCanH2O · College Athletes</div>
        <h1>Know your <span className="grad">hydration gap</span>. Close it with a plan built for you.</h1>
        <p className="lead">
          The Structured Hydration Assessment looks at your routines, access to water, training demands and habits.
          WeCanH2O reviews every result before it is shared with you.
        </p>
        <div className="row" style={{ marginTop: 22 }}>
          <a className="button" href="/signup">Athlete sign-up</a>
          <a className="button secondary" href="/login">Sign in</a>
        </div>
        <p className="muted small" style={{ marginTop: 14 }}>
          Sign up with the email on the team list your college sent. Not on a college team? <a href="/request-access">Request individual access</a>.
        </p>
      </section>

      <section className="grid3" style={{ marginTop: 34 }}>
        <div className="feature">
          <div className="ico">1</div>
          <h3>Take the assessment</h3>
          <p className="muted small">Eight short parts. Your answers save as you go, so you can finish later.</p>
        </div>
        <div className="feature">
          <div className="ico">2</div>
          <h3>WeCanH2O reviews it</h3>
          <p className="muted small">A WeCanH2O reviewer checks your result before anything is released to you.</p>
        </div>
        <div className="feature">
          <div className="ico">3</div>
          <h3>Get your strategy</h3>
          <p className="muted small">See your Hydration Gap Index, your strengths and your Hydration Action Items.</p>
        </div>
      </section>
    </main>
  );
}

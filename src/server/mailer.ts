// Transactional email delivery through Resend (https://resend.com). Emails are queued in email_outbox
// by the business transaction and delivered here after it commits. Without RESEND_API_KEY nothing is
// sent and rows stay Pending (automated tests run this way).
import type { PGlite } from '@electric-sql/pglite';

const MAX_ATTEMPTS = 3;
let running: Promise<void> | null = null;

function configured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function html(body: string, link: string | null) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = esc(body).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#0891b2">$1</a>').replace(/\n/g, '<br>');
  const button = link
    ? `<p style="margin:24px 0"><a href="${esc(link)}" style="background:#22d3ee;color:#03141c;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:700">Open link</a></p>`
    : '';
  return `<div style="font-family:Inter,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#14212b;max-width:560px">
    <p style="font-weight:700;color:#0b6e99">Structured Hydration Assessment</p>${text}${button}</div>`;
}

async function sendOne(row: { email_id: string; to_email: string; subject: string; body: string; link: string | null }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to: [row.to_email],
      subject: row.subject,
      text: row.body,
      html: html(row.body, row.link),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok) throw new Error(`${res.status} ${data.name ?? ''} ${data.message ?? ''}`.trim());
  return data.id ?? null;
}

async function deliver(pg: PGlite) {
  const rows = (await pg.query<{ email_id: string; to_email: string; subject: string; body: string; link: string | null; attempts: number }>(
    `select email_id, to_email, subject, body, link, attempts from email_outbox where status = 'Pending' order by email_id limit 50`,
  )).rows;
  for (const row of rows) {
    try {
      const id = await sendOne(row);
      await pg.query(`update email_outbox set status = 'Sent', sent_at = now(), attempts = attempts + 1, provider_message_id = $2, last_error = null where email_id = $1`,
        [row.email_id, id]);
    } catch (e) {
      const failed = row.attempts + 1 >= MAX_ATTEMPTS;
      await pg.query(`update email_outbox set attempts = attempts + 1, last_error = $2, status = $3 where email_id = $1`,
        [row.email_id, (e as Error).message.slice(0, 500), failed ? 'Failed' : 'Pending']);
      console.error(`[email] delivery to ${row.to_email} failed: ${(e as Error).message}`);
    }
  }
}

/** Delivers queued emails after a transaction commits. Runs one batch at a time; never throws. */
export function deliverQueuedEmails(pg: PGlite): Promise<void> {
  if (!configured()) return Promise.resolve(); // rows stay Pending until a provider is configured
  if (running) return running;
  running = deliver(pg).catch((e) => console.error('[email] delivery error', e)).finally(() => { running = null; });
  return running;
}

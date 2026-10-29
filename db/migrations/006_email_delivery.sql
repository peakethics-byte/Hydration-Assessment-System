-- 006 Real email delivery. email_outbox becomes the delivery log: emails are queued inside the business
-- transaction and only sent after it commits (no email for a rolled-back action).
alter table email_outbox add column status text not null default 'Pending'
  check (status in ('Pending', 'Sent', 'Failed', 'Not sent - no email service configured'));
alter table email_outbox add column attempts int not null default 0;
alter table email_outbox add column provider_message_id text;
alter table email_outbox add column last_error text;
alter table email_outbox add column sent_at timestamptz;

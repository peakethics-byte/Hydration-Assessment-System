import type { Tx } from './db';

export interface AuditEntry {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  recordType: string;
  recordId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ruleVersionId?: string | null;
}

export async function audit(tx: Tx, e: AuditEntry) {
  await tx.query(
    `insert into audit_event (tenant_id, user_id, action, record_type, record_id, old_value, new_value, reason, rule_version_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.tenantId ?? null,
      e.userId ?? null,
      e.action,
      e.recordType,
      e.recordId ?? null,
      e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
      e.newValue === undefined ? null : JSON.stringify(e.newValue),
      e.reason ?? null,
      e.ruleVersionId ?? null,
    ],
  );
}

/** Transactional email. Locally it is kept in email_outbox and shown in the Dev Mailbox. */
export async function sendEmail(tx: Tx, to: string, subject: string, body: string, link?: string) {
  await tx.query('insert into email_outbox (to_email, subject, body, link) values ($1, $2, $3, $4)', [to, subject, body, link ?? null]);
}

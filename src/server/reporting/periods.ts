import type { Db, Tx } from '../db';
import { audit } from '../audit';
import { requireAdmin } from '../roster';
import { programPeriods } from '../institution';

export const DEFAULT_THRESHOLD = 5;

// ---------------------------------------------------------------- settings, periods
export async function threshold(tx: Tx, tenantId: string): Promise<number> {
  const r = (await tx.query<{ suppression_threshold: number }>('select suppression_threshold from report_setting where tenant_id = $1', [tenantId])).rows[0];
  return r?.suppression_threshold ?? DEFAULT_THRESHOLD;
}

export interface Period { period_id: string; program_year_id: string; period_type: string; start_date: string; end_date: string; original_start: string; original_end: string }

export async function periodsFor(tx: Tx, tenantId: string) {
  const years = (await tx.query<{ program_year_id: string; program_start_date: string; program_end_date: string; status: string; renewed_from_id: string | null }>(
    `select program_year_id, program_start_date::text, program_end_date::text, status, renewed_from_id from program_year
     where tenant_id = $1 order by program_start_date desc`, [tenantId])).rows;
  const periods = (await tx.query<Period>(
    `select period_id, program_year_id, period_type, start_date::text, end_date::text, original_start::text, original_end::text
     from reporting_period where tenant_id = $1 order by (select y.program_start_date from program_year y where y.program_year_id = reporting_period.program_year_id), period_type = 'Annual', start_date`, [tenantId])).rows;
  return { years, periods };
}

/** The period containing today (quarters first), else the latest one. */
export function currentPeriod(periods: Period[], today = new Date().toISOString().slice(0, 10)) {
  const q = periods.filter((p) => p.period_type !== 'Annual');
  return q.find((p) => p.start_date <= today && today <= p.end_date) ?? q[q.length - 1] ?? periods[0];
}

/** Authorized reporting-date change, keeping the original and revised values (DAT-007, AUD-201). */
export async function adjustPeriod(db: Db, userId: string, input: { periodId: string; start: string; end: string; reason: string }) {
  return db.system(async (tx) => {
    const p = (await tx.query<Period & { tenant_id: string }>(
      'select period_id, tenant_id, program_year_id, period_type, start_date::text, end_date::text, original_start::text, original_end::text from reporting_period where period_id = $1',
      [input.periodId])).rows[0];
    if (!p) throw new Error('Reporting period not found.');
    await requireAdmin(tx, userId, p.tenant_id);
    if (!input.reason.trim()) return { ok: false as const, message: 'A reason is required for a reporting-date change.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.end) || input.end < input.start) {
      return { ok: false as const, message: 'Enter valid dates; the end date cannot be before the start date.' };
    }
    const released = (await tx.query(`select 1 from formal_report where period_id = $1 and status in ('Approved', 'Released')`, [p.period_id])).rows.length;
    if (released) return { ok: false as const, message: 'This period already has an approved or released report. Issue a correction instead.' };
    await tx.query(
      `insert into reporting_period_change (period_id, tenant_id, old_start, old_end, new_start, new_end, reason, changed_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`, [p.period_id, p.tenant_id, p.start_date, p.end_date, input.start, input.end, input.reason.trim(), userId]);
    await tx.query('update reporting_period set start_date = $2, end_date = $3, adjusted_by = $4, adjusted_reason = $5 where period_id = $1',
      [p.period_id, input.start, input.end, userId, input.reason.trim()]);
    await audit(tx, { tenantId: p.tenant_id, userId, action: 'adjust', recordType: 'reporting_period', recordId: p.period_id,
      oldValue: { start: p.start_date, end: p.end_date }, newValue: { start: input.start, end: input.end }, reason: input.reason.trim() });
    return { ok: true as const };
  });
}

export async function periodChanges(db: Db, userId: string, tenantId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<{ period_type: string; old_start: string; old_end: string; new_start: string; new_end: string; reason: string; changed_at: string; display_name: string }>(
    `select rp.period_type, c.old_start::text, c.old_end::text, c.new_start::text, c.new_end::text, c.reason, c.changed_at::text, u.display_name
     from reporting_period_change c join reporting_period rp using (period_id) join app_user u on u.user_id = c.changed_by
     where c.tenant_id = $1 order by c.changed_at desc`, [tenantId])).rows);
}

/** Renewal creates the next Program Year without touching earlier periods or reports (DAT-008). */
export async function renewProgramYear(db: Db, userId: string, tenantId: string) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, tenantId);
    const last = (await tx.query<{ program_year_id: string; program_end_date: string }>(
      'select program_year_id, program_end_date::text from program_year where tenant_id = $1 order by program_start_date desc limit 1', [tenantId])).rows[0];
    if (!last) throw new Error('No Program Year to renew.');
    const start = new Date(`${last.program_end_date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() + 1);
    const startDate = start.toISOString().slice(0, 10);
    const p = programPeriods(startDate);
    const py = (await tx.query<{ program_year_id: string }>(
      `insert into program_year (tenant_id, program_start_date, program_end_date, renewed_from_id, status) values ($1, $2, $3, $4, 'Setup') returning program_year_id`,
      [tenantId, startDate, p.annual.end, last.program_year_id])).rows[0].program_year_id;
    for (const period of [...p.quarters, p.annual]) {
      await tx.query(`insert into reporting_period (tenant_id, program_year_id, period_type, start_date, end_date, original_start, original_end)
        values ($1, $2, $3, $4, $5, $4, $5)`, [tenantId, py, period.type, period.start, period.end]);
    }
    await audit(tx, { tenantId, userId, action: 'renew', recordType: 'program_year', recordId: py, newValue: { startDate, renewedFrom: last.program_year_id } });
    return py;
  });
}

export async function setThreshold(db: Db, userId: string, tenantId: string, value: number) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, tenantId);
    if (!Number.isInteger(value) || value < 1 || value > 100) return { ok: false as const, message: 'Enter a whole number from 1 to 100.' };
    const old = await threshold(tx, tenantId);
    await tx.query(`insert into report_setting (tenant_id, suppression_threshold, updated_by, updated_at) values ($1, $2, $3, now())
      on conflict (tenant_id) do update set suppression_threshold = $2, updated_by = $3, updated_at = now()`, [tenantId, value, userId]);
    await audit(tx, { tenantId, userId, action: 'update', recordType: 'report_setting', recordId: tenantId, oldValue: { threshold: old }, newValue: { threshold: value } });
    return { ok: true as const };
  });
}

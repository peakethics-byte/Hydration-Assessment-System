import type { Db, Tx } from '../db';
import { audit } from '../audit';
import { requireAdmin } from '../roster';
import { annualExtra, buildData, type AnnualExtra, type ReportData } from './data';
import { reportScope, type ReportScope } from './scope';
import { periodsFor, type Period } from './periods';

export const QUARTERLY = 'Quarterly Hydration Gap Report';
export const ANNUAL = 'Annual Hydration Intelligence Impact Report';

// ---------------------------------------------------------------- formal reports
export interface FormalReport {
  report_id: string; tenant_id: string; program_year_id: string; period_id: string; report_type: string; report_number: string; version: number;
  status: string; content: { data: ReportData; annual?: AnnualExtra }; narrative: Record<string, string>; rule_versions: string[];
  suppression_threshold: number; generated_at: string; generated_by_name: string | null; submitted_at: string | null; review_note: string | null;
  approved_at: string | null; approved_by_name: string | null; released_at: string | null; supersedes_id: string | null; superseded_at: string | null;
  correction_reason: string | null;
}

/** Narrative written by WeCanH2O (never generated): what each report type needs before review. */
export const NARRATIVE_FIELDS: Record<string, { key: string; label: string; required: boolean; help: string }[]> = {
  [QUARTERLY]: [
    { key: 'priorityNotes', label: 'Section 8 - Priority Opportunities: reviewer notes', required: false, help: 'Optional comments on the rules-based priorities.' },
    { key: 'nextQuarterActions', label: 'Section 9 - Recommended Next-Quarter Actions', required: true, help: 'Approved practical priorities for next quarter. Required before review.' },
  ],
  [ANNUAL]: [
    { key: 'executiveSummary', label: 'Executive Summary', required: true, help: 'Describe observed patterns; do not claim the program caused them.' },
    { key: 'institutionalActions', label: 'Institutional Actions / Program Practice Developments', required: false, help: 'Actions the institution took this year.' },
    { key: 'nextYear', label: 'Next-Year Recommendations and Priorities', required: true, help: 'Required before review.' },
  ],
};

const reportSelect = `select r.report_id, r.tenant_id, r.program_year_id, r.period_id, r.report_type, r.report_number, r.version, r.status, r.content, r.narrative,
  r.rule_versions, r.suppression_threshold, r.generated_at::text, g.display_name as generated_by_name, r.submitted_at::text, r.review_note,
  r.approved_at::text, a.display_name as approved_by_name, r.released_at::text, r.supersedes_id, r.superseded_at::text, r.correction_reason
  from formal_report r left join app_user g on g.user_id = r.generated_by left join app_user a on a.user_id = r.approved_by`;

async function buildReportContent(tx: Tx, scope: ReportScope, period: Period) {
  const data = await buildData(tx, { ...scope, teamIds: null }, period, {});
  const type = period.period_type === 'Annual' ? ANNUAL : QUARTERLY;
  return { type, content: type === ANNUAL ? { data, annual: await annualExtra(tx, { ...scope, teamIds: null }, period, data) } : { data } };
}

async function adminReport(tx: Tx, userId: string, reportId: string) {
  const r = (await tx.query<FormalReport>(`${reportSelect} where r.report_id = $1`, [reportId])).rows[0];
  if (!r) throw new Error('Report not found.');
  await requireAdmin(tx, userId, r.tenant_id);
  return r;
}

/** Generates a Draft from stored data (REP-001, TST-REP-001). */
export async function generateReport(db: Db, userId: string, input: { tenantId: string; periodId: string }) {
  return db.system(async (tx) => {
    await requireAdmin(tx, userId, input.tenantId);
    const scope = await reportScope(tx, userId, input.tenantId);
    const period = (await periodsFor(tx, input.tenantId)).periods.find((p) => p.period_id === input.periodId);
    if (!period) throw new Error('Reporting period not found.');
    const open = (await tx.query<{ report_id: string }>(
      `select report_id from formal_report where period_id = $1 and status in ('Draft', 'Under Review', 'Revision Required', 'Approved')`, [period.period_id])).rows[0];
    if (open) return { ok: false as const, message: 'A report for this period is already in progress. Open it instead.', reportId: open.report_id };
    const released = (await tx.query(`select 1 from formal_report where period_id = $1 and status = 'Released'`, [period.period_id])).rows.length;
    if (released) return { ok: false as const, message: 'This period already has a released report. Issue a correction from that report instead.' };
    const { type, content } = await buildReportContent(tx, scope, period);
    const code = (await tx.query<{ display_name: string }>('select display_name from tenant where tenant_id = $1', [input.tenantId])).rows[0].display_name
      .replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase();
    const reportNumber = `${code}-${period.start_date.slice(0, 4)}-${period.period_type}`;
    const k = content.data.threshold;
    const id = (await tx.query<{ report_id: string }>(
      `insert into formal_report (tenant_id, program_year_id, period_id, report_type, report_number, version, content, rule_versions, suppression_threshold, generated_by)
       values ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9) returning report_id`,
      [input.tenantId, period.program_year_id, period.period_id, type, reportNumber, JSON.stringify(content), content.data.ruleVersions, k, userId])).rows[0].report_id;
    await audit(tx, { tenantId: input.tenantId, userId, action: 'generate', recordType: 'formal_report', recordId: id, newValue: { reportNumber, version: 1, type } });
    return { ok: true as const, reportId: id };
  });
}

/** Refreshes the figures of a report that is still being prepared. */
export async function regenerateReport(db: Db, userId: string, reportId: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!['Draft', 'Revision Required'].includes(r.status)) return { ok: false as const, message: `A report that is ${r.status} cannot be regenerated.` };
    const period = (await periodsFor(tx, r.tenant_id)).periods.find((p) => p.period_id === r.period_id)!;
    const { content } = await buildReportContent(tx, await reportScope(tx, userId, r.tenant_id), period);
    await tx.query('update formal_report set content = $2, rule_versions = $3, suppression_threshold = $4, generated_at = now(), generated_by = $5 where report_id = $1',
      [reportId, JSON.stringify(content), content.data.ruleVersions, content.data.threshold, userId]);
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'regenerate', recordType: 'formal_report', recordId: reportId });
    return { ok: true as const };
  });
}

export async function saveNarrative(db: Db, userId: string, reportId: string, narrative: Record<string, string>) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!['Draft', 'Revision Required', 'Under Review'].includes(r.status)) return { ok: false as const, message: `A report that is ${r.status} is locked.` };
    const allowed = NARRATIVE_FIELDS[r.report_type].map((f) => f.key);
    const clean = Object.fromEntries(allowed.map((k) => [k, String(narrative[k] ?? '').trim().slice(0, 5000)]));
    await tx.query('update formal_report set narrative = $2 where report_id = $1', [reportId, JSON.stringify(clean)]);
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'edit_narrative', recordType: 'formal_report', recordId: reportId });
    return { ok: true as const };
  });
}

type Step = 'submit' | 'revise' | 'approve' | 'release';
const FROM: Record<Step, string[]> = { submit: ['Draft', 'Revision Required'], revise: ['Under Review'], approve: ['Under Review'], release: ['Approved'] };
const TO: Record<Step, string> = { submit: 'Under Review', revise: 'Revision Required', approve: 'Approved', release: 'Released' };

/** Draft -> Under Review -> (Revision Required) -> Approved -> Released (LFC-201, REP-033). */
export async function reportStep(db: Db, userId: string, reportId: string, step: Step, note?: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (!FROM[step].includes(r.status)) return { ok: false as const, message: `This report is ${r.status}; that step is not available.` };
    if (step === 'submit') {
      const missing = NARRATIVE_FIELDS[r.report_type].filter((f) => f.required && !(r.narrative[f.key] ?? '').trim()).map((f) => f.label);
      if (missing.length) return { ok: false as const, message: `Complete before review: ${missing.join('; ')}.` };
    }
    if (step === 'revise' && !note?.trim()) return { ok: false as const, message: 'Explain what needs to change.' };
    const sets = {
      submit: 'submitted_at = now()',
      revise: 'review_note = $2',
      approve: 'approved_by = $2, approved_at = now()',
      release: 'released_by = $2, released_at = now()',
    }[step];
    await tx.query(`update formal_report set status = '${TO[step]}', ${sets} where report_id = $1`,
      step === 'revise' ? [reportId, note!.trim()] : step === 'submit' ? [reportId] : [reportId, userId]);
    if (step === 'release' && r.supersedes_id) {
      await tx.query(`update formal_report set status = 'Superseded', superseded_at = now() where report_id = $1`, [r.supersedes_id]);
      await audit(tx, { tenantId: r.tenant_id, userId, action: 'supersede', recordType: 'formal_report', recordId: r.supersedes_id, newValue: { supersededBy: reportId } });
    }
    await audit(tx, { tenantId: r.tenant_id, userId, action: step, recordType: 'formal_report', recordId: reportId,
      oldValue: { status: r.status }, newValue: { status: TO[step] }, reason: note?.trim() || null });
    return { ok: true as const };
  });
}

/** A released report is corrected by a new version; the original stays as it was (REP-034, TST-REP-011). */
export async function correctReport(db: Db, userId: string, reportId: string, reason: string) {
  return db.system(async (tx) => {
    const r = await adminReport(tx, userId, reportId);
    if (r.status !== 'Released') return { ok: false as const, message: 'Only a released report can be corrected.' };
    if (!reason.trim()) return { ok: false as const, message: 'A reason for the correction is required.' };
    const pending = (await tx.query(`select 1 from formal_report where supersedes_id = $1 and status <> 'Superseded'`, [reportId])).rows.length;
    if (pending) return { ok: false as const, message: 'A correction for this report is already in progress.' };
    const period = (await periodsFor(tx, r.tenant_id)).periods.find((p) => p.period_id === r.period_id)!;
    const { content } = await buildReportContent(tx, await reportScope(tx, userId, r.tenant_id), period);
    const version = (await tx.query<{ v: number }>('select max(version)::int as v from formal_report where report_number = $1', [r.report_number])).rows[0].v + 1;
    const id = (await tx.query<{ report_id: string }>(
      `insert into formal_report (tenant_id, program_year_id, period_id, report_type, report_number, version, content, narrative, rule_versions,
         suppression_threshold, generated_by, supersedes_id, correction_reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning report_id`,
      [r.tenant_id, r.program_year_id, r.period_id, r.report_type, r.report_number, version, JSON.stringify(content), JSON.stringify(r.narrative),
        content.data.ruleVersions, content.data.threshold, userId, reportId, reason.trim()])).rows[0].report_id;
    await audit(tx, { tenantId: r.tenant_id, userId, action: 'correct', recordType: 'formal_report', recordId: id,
      newValue: { reportNumber: r.report_number, version, supersedes: reportId }, reason: reason.trim() });
    return { ok: true as const, reportId: id };
  });
}

export async function listReports(db: Db, userId: string, tenantId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<FormalReport>(
    `${reportSelect} where r.tenant_id = $1 order by r.generated_at desc`, [tenantId])).rows);
}

/** Admin: any status. Institution leader: released reports of their institution only (row-level security). */
export async function getReport(db: Db, userId: string, reportId: string) {
  return db.asUser(userId, async (tx) => (await tx.query<FormalReport>(`${reportSelect} where r.report_id = $1`, [reportId])).rows[0] ?? null);
}

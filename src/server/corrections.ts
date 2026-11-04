// Governed correction of a submitted assessment (R-09; D07 LFC-014..016, AUD-101; D06 PRV-019).
// Complete / Scored (or later) -> Correction Required -> Revalidated. The original value, the corrected
// value, reason, user and time are kept; the earlier result is snapshotted and superseded, never erased.
import type { Db, Tx } from './db';
import { audit } from './audit';
import { PermissionError, requireAdmin } from './roster';
import { loadRuleSet } from './rules';
import { scoreInstance, type InstanceRow, type SubmitResult } from './assessment';
import { checkResponse, normalizeAnswer } from '../engine/scoring';

import { CORRECTABLE } from '../domain/status';

async function snapshot(tx: Tx, instanceId: string) {
  const q = (sql: string) => tx.query(sql, [instanceId]).then((r) => r.rows);
  return {
    hgi: await q('select hgi_internal, hgi_display, band, status, scr_version_id from hgi_result where instance_id = $1'),
    categories: await q('select category, raw_score, applicable_max, score_internal, score_display, percent_internal, status from category_score where instance_id = $1 order by category'),
    findings: await q('select finding_id, rule_id, rule_version_id, finding_type, title, source_class, priority_class, rank, is_safety, input_refs from hga_finding where instance_id = $1 and superseded_at is null'),
    ihs: await q('select ihs_id, status, reviewed_by, reviewed_at, approved_by, approved_at, released_at from ihs where instance_id = $1 and superseded_at is null'),
    recommendations: await q('select rec_id, finding_id, entry_id, pathway, status, reviewer_note, approved_by, approved_at, released_at from recommendation where instance_id = $1 and superseded_at is null'),
    actionItems: await q(`select a.action_item_id, a.rec_id, a.status, a.assigned_at, a.completed_at from action_item a join recommendation r using (rec_id)
                          where r.instance_id = $1 and a.superseded_at is null`),
    responses: await q('select item_code, response_state, option_code, option_codes, points from item_response where instance_id = $1 order by item_code'),
  };
}

export interface CorrectionInput { instanceId: string; itemCode: string; answer: string | string[] | null; reason: string }

export async function correctResponse(db: Db, adminUserId: string, c: CorrectionInput): Promise<SubmitResult> {
  if (!c.reason?.trim()) throw new PermissionError('A reason is required for every correction.');
  return db.system(async (tx) => {
    const inst = (await tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1 for update', [c.instanceId])).rows[0];
    if (!inst) throw new PermissionError('Assessment not found.');
    await requireAdmin(tx, adminUserId, inst.tenant_id);
    if (!CORRECTABLE.includes(inst.status)) {
      throw new PermissionError(`Only a submitted and validated assessment can be corrected (current: ${inst.status}).`);
    }
    const rules = await loadRuleSet(tx, { asmId: inst.asm_version_id, scrId: inst.scr_version_id, hgaId: inst.hga_version_id, recId: inst.rec_version_id });
    const item = rules.asm.items.find((i) => i.itemCode === c.itemCode);
    if (!item) throw new PermissionError('Unknown question.');
    const next = normalizeAnswer(item, c.answer ?? undefined);
    const problem = checkResponse(item, next);
    if (problem) throw new PermissionError(problem);
    if (item.required && next.state === 'blank') throw new PermissionError('A correction cannot remove an answer to a required question.');

    const old = (await tx.query<{ response_state: string; option_code: string | null; option_codes: string[] | null }>(
      'select response_state, option_code, option_codes from item_response where instance_id = $1 and item_code = $2', [c.instanceId, c.itemCode],
    )).rows[0] ?? { response_state: 'blank', option_code: null, option_codes: null };
    const same = old.response_state === next.state && (old.option_code ?? null) === (next.optionCode ?? null)
      && JSON.stringify(old.option_codes ?? null) === JSON.stringify(next.optionCodes ?? null);
    if (same) throw new PermissionError('The corrected answer is the same as the current answer.');

    const correctionId = (await tx.query<{ correction_id: string }>(
      `insert into response_correction (instance_id, tenant_id, item_code, original_state, original_option_code, original_option_codes,
         corrected_state, corrected_option_code, corrected_option_codes, reason, corrected_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning correction_id`,
      [c.instanceId, inst.tenant_id, c.itemCode, old.response_state, old.option_code, old.option_codes,
        next.state, next.optionCode ?? null, next.optionCodes ?? null, c.reason.trim(), adminUserId],
    )).rows[0].correction_id;

    // Keep the authoritative result as it was before this correction.
    const revisionNo = (await tx.query<{ n: number }>('select count(*)::int + 1 as n from result_revision where instance_id = $1', [c.instanceId])).rows[0].n;
    await tx.query(
      'insert into result_revision (instance_id, tenant_id, revision_no, status_before, snapshot, correction_id) values ($1, $2, $3, $4, $5, $6)',
      [c.instanceId, inst.tenant_id, revisionNo, inst.status, JSON.stringify(await snapshot(tx, c.instanceId)), correctionId],
    );

    const statusBefore = inst.status;
    await tx.query(`update assessment_instance set status = 'Correction Required', correction_count = correction_count + 1 where instance_id = $1`, [c.instanceId]);
    await audit(tx, { tenantId: inst.tenant_id, userId: adminUserId, action: 'status_change', recordType: 'assessment_instance', recordId: c.instanceId,
      oldValue: { status: statusBefore }, newValue: { status: 'Correction Required' } });
    inst.status = 'Correction Required';

    // Earlier findings, IHS, recommendations and action items stay in the database, marked superseded.
    for (const t of ['hga_finding', 'recommendation', 'action_item', 'ihs']) {
      const where = t === 'action_item'
        ? 'rec_id in (select rec_id from recommendation where instance_id = $1)'
        : 'instance_id = $1';
      await tx.query(`update ${t} set superseded_at = now() where ${where} and superseded_at is null`, [c.instanceId]);
    }

    await tx.query(
      `update item_response set response_state = $3, option_code = $4, option_codes = $5, points = null, updated_at = now()
       where instance_id = $1 and item_code = $2`,
      [c.instanceId, c.itemCode, next.state, next.optionCode ?? null, next.optionCodes ?? null],
    );
    await tx.query(
      `insert into item_response (instance_id, tenant_id, item_code, response_state, option_code, option_codes)
       values ($1, $2, $3, $4, $5, $6) on conflict (instance_id, item_code) do nothing`,
      [c.instanceId, inst.tenant_id, c.itemCode, next.state, next.optionCode ?? null, next.optionCodes ?? null],
    );
    await audit(tx, { tenantId: inst.tenant_id, userId: adminUserId, action: 'response_corrected', recordType: 'item_response', recordId: `${c.instanceId}/${c.itemCode}`,
      oldValue: old, newValue: { response_state: next.state, option_code: next.optionCode ?? null, option_codes: next.optionCodes ?? null },
      reason: c.reason.trim(), ruleVersionId: inst.asm_version_id });

    // Revalidate and rescore with the instance's own rule versions (LFC-015).
    const result = await scoreInstance(tx, inst, adminUserId, 'revalidate');
    if (!result.ok) throw new PermissionError(`Revalidation failed: ${result.statusLabel}`); // rolls back the whole correction
    return result;
  });
}

export async function correctionHistory(db: Db, adminUserId: string, instanceId: string) {
  return db.asUser(adminUserId, (tx) => tx.query<{ correction_id: string; item_code: string; original_state: string; original_option_code: string | null;
    original_option_codes: string[] | null; corrected_state: string; corrected_option_code: string | null; corrected_option_codes: string[] | null;
    reason: string; corrected_at: string; corrected_by_name: string }>(
    `select c.*, u.display_name as corrected_by_name from response_correction c join app_user u on u.user_id = c.corrected_by
     where c.instance_id = $1 order by c.corrected_at`, [instanceId],
  )).then((r) => r.rows);
}

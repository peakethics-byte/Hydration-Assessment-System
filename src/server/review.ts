// IHS & Recommendation workflow (F7) and Athlete Results Release (F8).
// Suggested by Rules Engine -> Reviewed -> Approved -> Assigned / Delivered. All actions run as the
// reviewer, so row-level security and the database release-gate checks apply on top of these checks.
import type { Db, Tx } from './db';
import { audit } from './audit';
import { PermissionError } from './roster';
import type { Pathway } from '../methodology/types';

async function denied(db: Db, userId: string, what: string, recordId?: string) {
  await db.system((tx) => audit(tx, { userId, action: 'denied', recordType: 'permission', recordId, reason: what }));
  return new PermissionError('You do not have permission for this action.');
}

async function adminInstance(tx: Tx, instanceId: string) {
  // Visible rows only; then require the Program Administrator role for that institution.
  return (await tx.query<{ instance_id: string; tenant_id: string; status: string; participant_id: string; is_admin: boolean }>(
    `select instance_id, tenant_id, status, participant_id, app_is_admin(tenant_id) as is_admin from assessment_instance where instance_id = $1`, [instanceId],
  )).rows[0];
}

export async function reviewQueue(db: Db, userId: string) {
  return db.asUser(userId, (tx) => tx.query<{
    instance_id: string; status: string; athlete_code: string; first_name: string; last_name: string; team: string | null; institution: string;
    hgi_display: string | null; band: string | null; safety: number; submitted_at: string;
  }>(
    `select i.instance_id, i.status, p.athlete_code, ap.first_name, ap.last_name, t.name as team, tn.display_name as institution,
            h.hgi_display, h.band, i.submitted_at,
            (select count(*)::int from hga_finding f where f.instance_id = i.instance_id and f.is_safety and f.superseded_at is null) as safety
     from assessment_instance i join participant p using (participant_id) join athlete_profile ap using (participant_id)
       join tenant tn on tn.tenant_id = i.tenant_id left join team t on t.team_id = i.team_id
       left join hgi_result h on h.instance_id = i.instance_id
     where i.status in ('Complete / Scored', 'Revalidated', 'Reviewed', 'Released') and app_is_admin(i.tenant_id)
     order by (i.status = 'Released'), safety desc, i.submitted_at`,
  )).then((r) => r.rows);
}

export async function reviewDetail(db: Db, userId: string, instanceId: string) {
  return db.asUser(userId, async (tx) => {
    const inst = await adminInstance(tx, instanceId);
    if (!inst?.is_admin) return null;
    const q = <T>(sql: string) => tx.query<T>(sql, [instanceId]).then((r) => r.rows);
    const [header] = await q<{ athlete_code: string; first_name: string; last_name: string; team: string | null; institution: string; status: string;
      asm_version_id: string; scr_version_id: string; hga_version_id: string; rec_version_id: string; submitted_at: string; is_baseline: boolean;
      heat_safety_procedures: string | null; released_at: string | null }>(
      `select p.athlete_code, ap.first_name, ap.last_name, t.name as team, tn.display_name as institution, i.status, i.asm_version_id, i.scr_version_id,
              i.hga_version_id, i.rec_version_id, i.submitted_at, i.is_baseline, t.heat_safety_procedures, i.released_at
       from assessment_instance i join participant p using (participant_id) join athlete_profile ap using (participant_id)
         join tenant tn on tn.tenant_id = i.tenant_id left join team t on t.team_id = i.team_id where i.instance_id = $1`);
    return {
      header,
      hgi: (await q<{ hgi_internal: string; hgi_display: string; band: string; status: string }>('select hgi_internal, hgi_display, band, status from hgi_result where instance_id = $1'))[0],
      categories: await q<{ category: string; raw_score: string | null; applicable_max: string | null; applicable_count: number | null; score_internal: string | null; score_display: string | null; percent_internal: string | null; status: string }>(
        'select category, raw_score, applicable_max, applicable_count, score_internal, score_display, percent_internal, status from category_score where instance_id = $1 order by category'),
      findings: await q<{ finding_id: string; rule_id: string; rule_version_id: string; finding_type: string; title: string; source_class: string | null; priority_class: number | null; rank: number | null; is_safety: boolean; input_refs: Record<string, unknown> }>(
        `select finding_id, rule_id, rule_version_id, finding_type, title, source_class, priority_class, rank, is_safety, input_refs
         from hga_finding where instance_id = $1 and superseded_at is null order by finding_type = 'strength', rank, category`),
      run: (await q<{ notes: { ruleId: string; note: string }[]; hydration_profile: Record<string, unknown> }>('select notes, hydration_profile from hga_run where instance_id = $1'))[0],
      recommendations: await q<{ rec_id: string; finding_id: string; rule_id: string; title: string; pathway: Pathway; also_available: Pathway[]; audience: string; reassessment_target: string;
        rank: number; is_safety: boolean; status: string; reviewer_note: string | null; athlete_text: string; staff_text: string; institution_text: string; is_placeholder: boolean; entry_id: string }>(
        `select r.rec_id, r.finding_id, f.rule_id, f.title, r.pathway, r.also_available, r.audience, r.reassessment_target, r.rank, r.is_safety, r.status, r.reviewer_note,
                e.athlete_text, e.staff_text, e.institution_text, e.is_placeholder, r.entry_id
         from recommendation r join hga_finding f using (finding_id) join rec_library_entry e using (entry_id) where r.instance_id = $1 and r.superseded_at is null order by r.rank`),
      responses: await q<{ item_code: string; response_state: string; option_code: string | null; option_codes: string[] | null; points: string | null }>(
        'select item_code, response_state, option_code, option_codes, points from item_response where instance_id = $1'),
      ihs: (await q<{ ihs_id: string; status: string }>('select ihs_id, status from ihs where instance_id = $1 and superseded_at is null'))[0],
    };
  });
}

/** Reviewer opens the record and marks it Reviewed. */
export async function markReviewed(db: Db, userId: string, instanceId: string) {
  const ok = await db.asUser(userId, async (tx) => {
    const inst = await adminInstance(tx, instanceId);
    if (!inst?.is_admin) return false;
    if (!['Complete / Scored', 'Revalidated'].includes(inst.status)) {
      throw new PermissionError(`Only a Complete / Scored or Revalidated record can be marked Reviewed (current: ${inst.status}).`);
    }
    await tx.query(`update assessment_instance set status = 'Reviewed', reviewed_at = now() where instance_id = $1`, [instanceId]);
    await tx.query(`update ihs set status = 'Reviewed', reviewed_by = $2, reviewed_at = now() where instance_id = $1 and superseded_at is null`, [instanceId, userId]);
    await tx.query(`update recommendation set status = 'Reviewed', reviewed_by = $2, reviewed_at = now() where instance_id = $1 and status = 'Suggested by Rules Engine' and superseded_at is null`, [instanceId, userId]);
    await audit(tx, { tenantId: inst.tenant_id, userId, action: 'status_change', recordType: 'assessment_instance', recordId: instanceId,
      oldValue: { status: inst.status }, newValue: { status: 'Reviewed' } });
    return true;
  });
  if (!ok) throw await denied(db, userId, 'mark reviewed', instanceId);
}

export interface RecDecision { recId: string; decision: 'approve' | 'not_approve'; pathway?: Pathway; note?: string }

/** Approve (optionally choosing another available pathway) or Not Approve one recommendation. */
export async function decideRecommendation(db: Db, userId: string, d: RecDecision) {
  const ok = await db.asUser(userId, async (tx) => {
    const r = (await tx.query<{ rec_id: string; tenant_id: string; instance_id: string; status: string; pathway: Pathway; also_available: Pathway[]; entry_id: string; rule_id: string; rec_version_id: string }>(
      `select r.rec_id, r.tenant_id, r.instance_id, r.status, r.pathway, r.also_available, r.entry_id, f.rule_id, r.rec_version_id
       from recommendation r join hga_finding f using (finding_id) where r.rec_id = $1 and r.superseded_at is null and app_is_admin(r.tenant_id)`, [d.recId],
    )).rows[0];
    if (!r) return false;
    if (r.status !== 'Reviewed') throw new PermissionError('Mark the record Reviewed before approving recommendations.');
    let entryId = r.entry_id;
    let pathway = r.pathway;
    if (d.decision === 'approve' && d.pathway && d.pathway !== r.pathway) {
      if (!r.also_available.includes(d.pathway)) throw new PermissionError('That pathway is not available for this finding.');
      const e = (await tx.query<{ entry_id: string }>(
        'select entry_id from rec_library_entry where rec_version_id = $1 and finding_rule_id = $2 and pathway = $3', [r.rec_version_id, r.rule_id, d.pathway],
      )).rows[0];
      if (!e) throw new PermissionError('No approved library entry exists for that pathway.');
      entryId = e.entry_id;
      pathway = d.pathway;
    }
    const status = d.decision === 'approve' ? 'Approved' : 'Not Approved';
    await tx.query(
      `update recommendation set status = $2, pathway = $3, entry_id = $4, reviewer_note = $5,
         approved_by = case when $2 = 'Approved' then $6::uuid end, approved_at = case when $2 = 'Approved' then now() end
       where rec_id = $1`,
      [d.recId, status, pathway, entryId, d.note?.trim() || null, userId],
    );
    await audit(tx, { tenantId: r.tenant_id, userId, action: d.decision === 'approve' ? 'recommendation_approved' : 'recommendation_not_approved',
      recordType: 'recommendation', recordId: d.recId, oldValue: { status: r.status, pathway: r.pathway }, newValue: { status, pathway, note: d.note ?? null },
      ruleVersionId: r.rec_version_id });
    return true;
  });
  if (!ok) throw await denied(db, userId, 'decide recommendation', d.recId);
}

/** Release approved results and IHS to the athlete. Nothing is released before every suggestion is decided. */
export async function releaseResults(db: Db, userId: string, instanceId: string) {
  const ok = await db.asUser(userId, async (tx) => {
    const inst = await adminInstance(tx, instanceId);
    if (!inst?.is_admin) return false;
    if (inst.status !== 'Reviewed') throw new PermissionError('Only a Reviewed record can be released.');
    const open = (await tx.query<{ n: number }>(
      `select count(*)::int as n from recommendation where instance_id = $1 and superseded_at is null and status not in ('Approved', 'Not Approved')`, [instanceId],
    )).rows[0].n;
    if (open > 0) throw new PermissionError(`${open} recommendation(s) still need a decision.`);
    await tx.query(`update ihs set status = 'Approved', approved_by = $2, approved_at = now() where instance_id = $1 and superseded_at is null`, [instanceId, userId]);
    const released = (await tx.query<{ rec_id: string; audience: string }>(
      `update recommendation set status = 'Assigned / Delivered', released_at = now() where instance_id = $1 and status = 'Approved' and superseded_at is null returning rec_id, audience`, [instanceId],
    )).rows;
    for (const r of released.filter((x) => x.audience === 'athlete' || x.audience === 'health_support')) {
      await tx.query('insert into action_item (rec_id, tenant_id, participant_id) values ($1, $2, $3)', [r.rec_id, inst.tenant_id, inst.participant_id]);
    }
    await tx.query(`update ihs set status = 'Assigned / Delivered', released_at = now() where instance_id = $1 and superseded_at is null`, [instanceId]);
    await tx.query(`update assessment_instance set status = 'Released', released_at = now() where instance_id = $1`, [instanceId]);
    await audit(tx, { tenantId: inst.tenant_id, userId, action: 'results_released', recordType: 'assessment_instance', recordId: instanceId,
      oldValue: { status: inst.status }, newValue: { status: 'Released', recommendationsReleased: released.length } });
    return true;
  });
  if (!ok) throw await denied(db, userId, 'release results', instanceId);
}

export async function setTeamProcedures(db: Db, userId: string, teamId: string, value: 'exist' | 'none' | 'unknown') {
  const ok = await db.asUser(userId, async (tx) => {
    const t = (await tx.query<{ tenant_id: string; heat_safety_procedures: string }>(
      'select tenant_id, heat_safety_procedures from team where team_id = $1 and app_is_admin(tenant_id)', [teamId])).rows[0];
    if (!t) return false;
    await tx.query('update team set heat_safety_procedures = $2 where team_id = $1', [teamId, value]);
    await audit(tx, { tenantId: t.tenant_id, userId, action: 'update', recordType: 'team', recordId: teamId,
      oldValue: { heatSafetyProcedures: t.heat_safety_procedures }, newValue: { heatSafetyProcedures: value } });
    return true;
  });
  if (!ok) throw await denied(db, userId, 'update team procedures', teamId);
}

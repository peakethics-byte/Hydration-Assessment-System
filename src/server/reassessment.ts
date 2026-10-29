// Reassessment workflow and stored change analysis (Document #4 REA / CHG; Milestone 3 Section 5).
// Baseline -> HGA / IHS -> actions -> reassessment -> comparability check -> change -> updated priorities.
import type { Db, Tx } from './db';
import { audit, sendEmail } from './audit';
import { loadRuleSet } from './rules';
import { loadResponses } from './assessment';
import { PermissionError, requireAdmin } from './roster';
import { compareAssessments, isComparable, type Snapshot } from '../engine/change';

/** Assessment statuses that hold a valid, scored result. */
export const SCORED = ['Complete / Scored', 'Reviewed', 'Released', 'Revalidated'];
export const OUTCOME_UNKNOWN = 'Reassessment Not Completed / Outcome Unknown';

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------- Scheduling (REA-007..010) ----------
/** Default target window: the next quarterly reporting period of the athlete's Program Year (adjustable). */
export async function suggestedWindow(tx: Tx, tenantId: string) {
  const r = (await tx.query<{ period_type: string; start_date: string; end_date: string }>(
    `select rp.period_type, rp.start_date::text, rp.end_date::text from reporting_period rp join program_year py using (program_year_id)
     where rp.tenant_id = $1 and py.status = 'Active' and rp.period_type <> 'Annual' and rp.end_date >= current_date
     order by (rp.start_date > current_date) desc, rp.start_date limit 1`, [tenantId])).rows[0];
  if (r) return { start: r.start_date, end: r.end_date, label: r.period_type };
  const today = new Date();
  return { start: iso(today), end: iso(new Date(today.getTime() + 30 * 86_400_000)), label: '30 days' };
}

export interface ScheduleInput { tenantId: string; teamId?: string; participantIds?: string[]; targetStart: string; targetEnd: string }

export async function scheduleReassessment(db: Db, adminUserId: string, input: ScheduleInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.targetEnd)) throw new PermissionError('Please enter both dates.');
  if (input.targetEnd < input.targetStart) throw new PermissionError('The window must end on or after its start date.');
  return db.system(async (tx) => {
    await requireAdmin(tx, adminUserId, input.tenantId);
    const candidates = (await tx.query<{ participant_id: string; first_name: string; last_name: string; email: string; program_year_id: string | null; open: boolean }>(
      `select p.participant_id, ap.first_name, ap.last_name, ap.email,
              (select i.program_year_id from assessment_instance i where i.participant_id = p.participant_id and i.is_baseline
                 and i.status = any($3) order by i.submitted_at desc limit 1) as program_year_id,
              exists (select 1 from reassessment_schedule s where s.participant_id = p.participant_id and s.outcome = 'Scheduled') as open
       from participant p join athlete_profile ap using (participant_id)
       where p.tenant_id = $1 and p.status = 'Active'
         and ($2::uuid is null or exists (select 1 from athlete_team_affiliation a where a.participant_id = p.participant_id and a.team_id = $2
              and a.effective_start <= current_date and (a.effective_end is null or a.effective_end >= current_date)))
         and ($4::uuid[] is null or p.participant_id = any($4))
       order by ap.last_name, ap.first_name`,
      [input.tenantId, input.teamId ?? null, SCORED, input.participantIds ?? null])).rows;
    const scheduled: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const c of candidates) {
      const name = `${c.first_name} ${c.last_name}`;
      if (!c.program_year_id) { skipped.push({ name, reason: 'no completed baseline yet' }); continue; }
      if (c.open) { skipped.push({ name, reason: 'a reassessment window is already open' }); continue; }
      const id = (await tx.query<{ schedule_id: string }>(
        `insert into reassessment_schedule (tenant_id, participant_id, program_year_id, target_start, target_end, created_by)
         values ($1, $2, $3, $4, $5, $6) returning schedule_id`,
        [input.tenantId, c.participant_id, c.program_year_id, input.targetStart, input.targetEnd, adminUserId])).rows[0].schedule_id;
      const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { dateStyle: 'long' });
      await sendEmail(tx, c.email, 'Your Structured Hydration Assessment reassessment is open', [
        `Hello ${c.first_name},`, '',
        `Your reassessment is open from ${fmt(input.targetStart)} to ${fmt(input.targetEnd)}.`,
        'Please sign in and take the Structured Hydration Assessment again during this time.',
      ].join('\n'));
      await audit(tx, { tenantId: input.tenantId, userId: adminUserId, action: 'reassessment_scheduled', recordType: 'reassessment_schedule', recordId: id,
        newValue: { participantId: c.participant_id, targetStart: input.targetStart, targetEnd: input.targetEnd } });
      scheduled.push(name);
    }
    return { scheduled, skipped };
  });
}

export async function cancelSchedule(db: Db, adminUserId: string, scheduleId: string) {
  return db.system(async (tx) => {
    const s = (await tx.query<{ tenant_id: string; outcome: string; actual_instance_id: string | null }>(
      'select tenant_id, outcome, actual_instance_id from reassessment_schedule where schedule_id = $1', [scheduleId])).rows[0];
    if (!s) throw new PermissionError('Reassessment window not found.');
    await requireAdmin(tx, adminUserId, s.tenant_id);
    if (s.outcome !== 'Scheduled') throw new PermissionError('Only an open window can be cancelled.');
    if (s.actual_instance_id) throw new PermissionError('The athlete has already started this reassessment.');
    await tx.query(`update reassessment_schedule set outcome = 'Cancelled', closed_at = now() where schedule_id = $1`, [scheduleId]);
    await audit(tx, { tenantId: s.tenant_id, userId: adminUserId, action: 'reassessment_cancelled', recordType: 'reassessment_schedule', recordId: scheduleId });
  });
}

/** Closed windows without a valid reassessment: Outcome Unknown, never "no change" (REA-010, CHG-023). */
export async function closeMissedWindows(tx: Tx) {
  const missed = (await tx.query<{ schedule_id: string; tenant_id: string }>(
    `update reassessment_schedule s set outcome = $1, closed_at = now()
     where s.outcome = 'Scheduled' and s.target_end < current_date
       and not exists (select 1 from assessment_instance i where i.instance_id = s.actual_instance_id and i.status = any($2))
     returning s.schedule_id, s.tenant_id`, [OUTCOME_UNKNOWN, SCORED])).rows;
  for (const m of missed) {
    await audit(tx, { tenantId: m.tenant_id, action: 'reassessment_outcome_unknown', recordType: 'reassessment_schedule', recordId: m.schedule_id });
  }
  return missed.length;
}

/** The open window an athlete can start a reassessment in today, if any. */
export async function openWindowFor(tx: Tx, participantId: string) {
  return (await tx.query<{ schedule_id: string; program_year_id: string; target_start: string; target_end: string; actual_instance_id: string | null }>(
    `select schedule_id, program_year_id, target_start::text, target_end::text, actual_instance_id from reassessment_schedule
     where participant_id = $1 and outcome = 'Scheduled' and target_start <= current_date and target_end >= current_date`, [participantId])).rows[0] ?? null;
}

// ---------- Change analysis (CHG-001..016) ----------
async function snapshot(tx: Tx, instanceId: string): Promise<Snapshot & { hgaVersion: string; asmVersion: string; scrVersion: string; recVersion: string }> {
  const inst = (await tx.query<{ asm_version_id: string; scr_version_id: string; hga_version_id: string; rec_version_id: string }>(
    'select asm_version_id, scr_version_id, hga_version_id, rec_version_id from assessment_instance where instance_id = $1', [instanceId])).rows[0];
  const hgi = (await tx.query<{ hgi_internal: string }>('select hgi_internal::text from hgi_result where instance_id = $1', [instanceId])).rows[0];
  const cats = (await tx.query<{ category: string; score_internal: string | null; percent_internal: string | null }>(
    `select category, score_internal::text, percent_internal::text from category_score where instance_id = $1 and status = 'Scored'`, [instanceId])).rows;
  const pts = (await tx.query<{ item_code: string; points: string | null }>('select item_code, points::text from item_response where instance_id = $1', [instanceId])).rows;
  const findings = (await tx.query<{ rule_id: string; title: string; is_safety: boolean; source_class: string | null; priority_class: number | null }>(
    `select rule_id, title, is_safety, source_class, priority_class from hga_finding
     where instance_id = $1 and finding_type <> 'strength' and superseded_at is null`, [instanceId])).rows;
  return {
    asmVersion: inst.asm_version_id, scrVersion: inst.scr_version_id, hgaVersion: inst.hga_version_id, recVersion: inst.rec_version_id,
    versions: { asm: inst.asm_version_id, scr: inst.scr_version_id, hga: inst.hga_version_id },
    hgiInternal: hgi.hgi_internal,
    categories: Object.fromEntries(cats.map((c) => [c.category, { internal: c.score_internal, percent: c.percent_internal }])),
    responses: await loadResponses(tx, instanceId),
    itemPoints: Object.fromEntries(pts.map((p) => [p.item_code, p.points == null ? null : Number(p.points)])),
    findings: findings.map((f) => ({ ruleId: f.rule_id, title: f.title, isSafety: f.is_safety, source: f.source_class, priority: f.priority_class })),
  };
}

async function approvedMappings(tx: Tx) {
  return new Set((await tx.query<{ k: string }>(`select from_version_id || '>' || to_version_id as k from rule_version_mapping`)).rows.map((r) => r.k));
}

/** Rule IDs found at the athlete's previous comparable scored assessment (for priority class 4). */
export async function priorFindingsFor(tx: Tx, instanceId: string) {
  const cur = (await tx.query<{ participant_id: string; asm_version_id: string; scr_version_id: string; hga_version_id: string; created: string }>(
    `select participant_id, asm_version_id, scr_version_id, hga_version_id, coalesce(submitted_at, started_at, now())::text as created
     from assessment_instance where instance_id = $1`, [instanceId])).rows[0];
  const prev = (await tx.query<{ instance_id: string; asm_version_id: string; scr_version_id: string; hga_version_id: string }>(
    `select instance_id, asm_version_id, scr_version_id, hga_version_id from assessment_instance
     where participant_id = $1 and instance_id <> $2 and status = any($3) and submitted_at < $4::timestamptz
     order by submitted_at desc limit 1`, [cur.participant_id, instanceId, SCORED, cur.created])).rows[0];
  if (!prev) return new Set<string>();
  const comparable = isComparable(
    { asm: prev.asm_version_id, scr: prev.scr_version_id, hga: prev.hga_version_id },
    { asm: cur.asm_version_id, scr: cur.scr_version_id, hga: cur.hga_version_id }, await approvedMappings(tx));
  if (!comparable) return new Set<string>();
  return new Set((await tx.query<{ rule_id: string }>(
    `select rule_id from hga_finding where instance_id = $1 and finding_type <> 'strength' and superseded_at is null`, [prev.instance_id])).rows.map((r) => r.rule_id));
}

/** Stores baseline -> current change for one reassessment. Earlier analyses are superseded, never overwritten. */
export async function computeChange(tx: Tx, currentInstanceId: string) {
  const cur = (await tx.query<{ participant_id: string; tenant_id: string; program_year_id: string; is_baseline: boolean; status: string }>(
    'select participant_id, tenant_id, program_year_id, is_baseline, status from assessment_instance where instance_id = $1', [currentInstanceId])).rows[0];
  if (!cur || cur.is_baseline || !SCORED.includes(cur.status)) return null;
  const base = (await tx.query<{ instance_id: string }>(
    `select instance_id from assessment_instance where participant_id = $1 and is_baseline and status = any($2)
     order by (program_year_id = $3) desc, submitted_at desc limit 1`, [cur.participant_id, SCORED, cur.program_year_id])).rows[0];
  if (!base) return null;
  const [b, c] = [await snapshot(tx, base.instance_id), await snapshot(tx, currentInstanceId)];
  const rules = await loadRuleSet(tx, { asmId: c.asmVersion, scrId: c.scrVersion, hgaId: c.hgaVersion, recId: c.recVersion });
  const r = compareAssessments(rules.asm, rules.hga, b, c, await approvedMappings(tx));

  await tx.query('update change_analysis set superseded_at = now() where current_instance_id = $1 and superseded_at is null', [currentInstanceId]);
  const id = (await tx.query<{ change_analysis_id: string }>(
    `insert into change_analysis (tenant_id, participant_id, baseline_instance_id, current_instance_id, comparison_status, hgi_baseline, hgi_current, hgi_change,
       category_changes, item_changes, contextual_changes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning change_analysis_id`,
    [cur.tenant_id, cur.participant_id, base.instance_id, currentInstanceId, r.status, r.hgiBaseline, r.hgiCurrent, r.hgiChange,
      JSON.stringify(r.categoryChanges), JSON.stringify(r.itemChanges), JSON.stringify(r.contextualChanges)])).rows[0].change_analysis_id;
  for (const f of r.findingChanges) {
    await tx.query(
      `insert into finding_change (change_analysis_id, tenant_id, rule_id, title, state, measure_label, baseline_measure, current_measure,
         source_class, priority_class, is_safety, is_contextual) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [id, cur.tenant_id, f.ruleId, f.title, f.state, f.measureLabel, f.baselineMeasure, f.currentMeasure, f.source, f.priority, f.isSafety, f.isContextual]);
  }
  await audit(tx, { tenantId: cur.tenant_id, action: 'change_analysis', recordType: 'assessment_instance', recordId: currentInstanceId,
    newValue: { status: r.status, hgiChange: r.hgiChange, states: r.findingChanges.map((f) => `${f.ruleId}:${f.state}`) }, ruleVersionId: c.hgaVersion });
  return id;
}

/** After any scoring or correction: refresh the change analyses of the athlete's reassessments and close the window. */
export async function afterScored(tx: Tx, instanceId: string) {
  const inst = (await tx.query<{ participant_id: string; schedule_id: string | null; tenant_id: string }>(
    'select participant_id, schedule_id, tenant_id from assessment_instance where instance_id = $1', [instanceId])).rows[0];
  if (inst.schedule_id) {
    const s = await tx.query(
      `update reassessment_schedule set outcome = 'Completed', actual_instance_id = $2, closed_at = now()
       where schedule_id = $1 and outcome <> 'Completed' returning schedule_id`, [inst.schedule_id, instanceId]);
    if (s.rows.length) await audit(tx, { tenantId: inst.tenant_id, action: 'reassessment_completed', recordType: 'reassessment_schedule', recordId: inst.schedule_id });
  }
  const later = (await tx.query<{ instance_id: string }>(
    `select instance_id from assessment_instance where participant_id = $1 and not is_baseline and status = any($2) order by submitted_at`,
    [inst.participant_id, SCORED])).rows;
  for (const l of later) await computeChange(tx, l.instance_id);
}

export async function windowSuggestion(db: Db, tenantId: string) {
  return db.system((tx) => suggestedWindow(tx, tenantId));
}

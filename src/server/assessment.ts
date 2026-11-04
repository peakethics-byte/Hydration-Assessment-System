// Structured Hydration Assessment (F4), validation & scoring (F5), HGA (F6) and Suggested IHS (F7).
// Lifecycle: Not Started -> In Progress (14-day draft) -> Submitted -> Validation Check -> Complete / Scored.
import type { Db, Tx } from './db';
import { audit, sendEmail } from './audit';
import { activeRuleIds, loadRuleSet, type RuleSet } from './rules';
import { checkResponse, normalizeAnswer, scoreAssessment, type Responses } from '../engine/scoring';
import { buildProfile, runHga } from '../engine/hga';
import { suggestRecommendations } from '../engine/ihs';
import { PermissionError, requireAdmin } from './roster';
import { currentProgramYear } from './institution';
import { afterScored, closeMissedWindows, openWindowFor, priorFindingsFor, SCORED } from './reassessment';
import { longDate } from '../domain/format';

export const DRAFT_DAYS = 14;

export interface InstanceRow {
  instance_id: string;
  tenant_id: string;
  participant_id: string;
  team_id: string | null;
  status: string;
  asm_version_id: string;
  scr_version_id: string;
  hga_version_id: string;
  rec_version_id: string;
  draft_expires_at: string | null;
  submitted_at: string | null;
  released_at: string | null;
}

const ruleIdsOf = (i: InstanceRow) => ({ asmId: i.asm_version_id, scrId: i.scr_version_id, hgaId: i.hga_version_id, recId: i.rec_version_id });

async function participantOf(tx: Tx, userId: string) {
  const p = (await tx.query<{ participant_id: string; tenant_id: string; population_code: string }>(
    `select participant_id, tenant_id, population_code from participant where user_id = $1 and status = 'Active'`, [userId],
  )).rows[0];
  if (!p) throw new PermissionError('Only athletes can take the assessment.');
  return p;
}

async function setStatus(tx: Tx, inst: InstanceRow, to: string, userId: string | null, extra = '') {
  await tx.query(`update assessment_instance set status = $2 ${extra} where instance_id = $1`, [inst.instance_id, to]);
  await audit(tx, { tenantId: inst.tenant_id, userId, action: 'status_change', recordType: 'assessment_instance', recordId: inst.instance_id,
    oldValue: { status: inst.status }, newValue: { status: to } });
  inst.status = to;
}

/** Draft lifecycle (M1 O-05): a reminder before the draft window closes, then Expired.
 *  Unsubmitted answers are kept (no automatic permanent deletion, D06 PRV-020); an administrator can reopen. */
export async function draftMaintenance(db: Db) {
  return db.system(async (tx) => {
    const due = (await tx.query<InstanceRow & { email: string; first_name: string }>(
      `select i.*, ap.email, ap.first_name from assessment_instance i join athlete_profile ap using (participant_id)
       left join privacy_config pc on pc.tenant_id = i.tenant_id
       where i.status = 'In Progress' and i.reminder_sent_at is null and i.draft_expires_at > now()
         and i.draft_expires_at <= now() + make_interval(days => coalesce(pc.reminder_days_before, 3))`,
    )).rows;
    for (const inst of due) {
      const by = longDate(inst.draft_expires_at);
      await sendEmail(tx, inst.email, 'Reminder: finish your Structured Hydration Assessment',
        [`Hello ${inst.first_name},`, '', 'You started the Structured Hydration Assessment but have not submitted it yet.',
          `Your saved answers are kept until ${by}. Please sign in and submit before then.`].join('\n'));
      await tx.query('update assessment_instance set reminder_sent_at = now() where instance_id = $1', [inst.instance_id]);
      await audit(tx, { tenantId: inst.tenant_id, action: 'draft_reminder_sent', recordType: 'assessment_instance', recordId: inst.instance_id });
    }
    const expired = (await tx.query<InstanceRow>(
      `select * from assessment_instance where status = 'In Progress' and draft_expires_at <= now()`,
    )).rows;
    for (const inst of expired) await setStatus(tx, inst, 'Expired', null);
    const missedReassessments = await closeMissedWindows(tx);
    return { reminded: due.length, expired: expired.length, missedReassessments };
  });
}

/** Administrator reopens an expired draft with a new draft window; the saved answers are kept. */
export async function reopenDraft(db: Db, adminUserId: string, instanceId: string) {
  return db.system(async (tx) => {
    const inst = (await tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1 for update', [instanceId])).rows[0];
    if (!inst) throw new PermissionError('Assessment not found.');
    await requireAdmin(tx, adminUserId, inst.tenant_id);
    if (inst.status !== 'Expired') throw new PermissionError('Only an expired draft can be reopened.');
    const other = (await tx.query(
      `select 1 from assessment_instance where participant_id = $1 and instance_id <> $2 and status in ('Not Started', 'In Progress')`,
      [inst.participant_id, instanceId])).rows.length;
    if (other) throw new PermissionError('The athlete has already started a new assessment.');
    await setStatus(tx, inst, 'In Progress', adminUserId,
      `, reminder_sent_at = null, draft_expires_at = now() + make_interval(days => coalesce((select draft_days from privacy_config pc where pc.tenant_id = assessment_instance.tenant_id), ${DRAFT_DAYS}))`);
  });
}

// ---------- Acknowledgment / consent gate (R-41). Wording comes from WeCanH2O. ----------
export async function ackStatus(db: Db, userId: string) {
  return db.system(async (tx) => {
    const p = await participantOf(tx, userId);
    const cfg = (await tx.query<{ ack_required: boolean; ack_document_version_id: string | null; body: string | null }>(
      `select pc.ack_required, pc.ack_document_version_id, d.body from privacy_config pc
       left join ack_document_version d on d.document_version_id = pc.ack_document_version_id where pc.tenant_id = $1`, [p.tenant_id],
    )).rows[0];
    if (!cfg?.ack_required || !cfg.ack_document_version_id) return { required: false as const };
    const done = (await tx.query('select 1 from ack_record where participant_id = $1 and document_version_id = $2',
      [p.participant_id, cfg.ack_document_version_id])).rows.length > 0;
    return { required: true as const, acknowledged: done, documentVersionId: cfg.ack_document_version_id, body: cfg.body ?? '' };
  });
}

async function requireAck(db: Db, userId: string) {
  const a = await ackStatus(db, userId);
  if (a.required && !a.acknowledged) throw new PermissionError('Please read and acknowledge the participation statement first.');
}

export async function acknowledge(db: Db, userId: string, documentVersionId: string) {
  const a = await ackStatus(db, userId);
  if (!a.required || a.documentVersionId !== documentVersionId) throw new PermissionError('This acknowledgment is not current.');
  if (a.acknowledged) return;
  await db.asUser(userId, async (tx) => {
    const p = (await tx.query<{ participant_id: string; tenant_id: string }>(
      'select participant_id, tenant_id from participant where user_id = app_uid()')).rows[0];
    const py = (await tx.query<{ program_year_id: string }>(
      `select program_year_id from program_year where tenant_id = $1 and status = 'Active' order by program_start_date desc limit 1`, [p.tenant_id])).rows[0];
    await tx.query('insert into ack_record (tenant_id, participant_id, program_year_id, document_version_id) values ($1, $2, $3, $4)',
      [p.tenant_id, p.participant_id, py?.program_year_id ?? null, documentVersionId]);
    await audit(tx, { tenantId: p.tenant_id, userId, action: 'acknowledged', recordType: 'ack_record', recordId: documentVersionId });
  });
}

/** The athlete's open assessment, created on first visit with the currently Active rule versions. */
export async function openAssessment(db: Db, userId: string): Promise<InstanceRow> {
  await draftMaintenance(db);
  return db.system(async (tx) => {
    const p = await participantOf(tx, userId);
    const existing = (await tx.query<InstanceRow>(
      `select * from assessment_instance where participant_id = $1 and status not in ('Expired') order by started_at desc nulls first limit 1`,
      [p.participant_id],
    )).rows[0];
    // A reassessment is a new, separate instance (REA-001); it never replaces the baseline (REA-002).
    const window = existing && (SCORED.includes(existing.status) || existing.status === 'Correction Required')
      ? await openWindowFor(tx, p.participant_id) : null;
    if (existing && !window) return existing;
    if (window?.actual_instance_id) {
      const started = (await tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1', [window.actual_instance_id])).rows[0];
      if (started && started.status !== 'Expired') return started;
    }
    const ids = await activeRuleIds(tx, p.population_code);
    const team = (await tx.query<{ team_id: string }>(
      `select team_id from athlete_team_affiliation where participant_id = $1 and effective_start <= current_date
       and (effective_end is null or effective_end >= current_date) order by effective_start limit 1`, [p.participant_id],
    )).rows[0];
    const inst = (await tx.query<InstanceRow>(
      `insert into assessment_instance (tenant_id, participant_id, program_year_id, team_id, asm_version_id, scr_version_id, hga_version_id, rec_version_id, schedule_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [p.tenant_id, p.participant_id, window?.program_year_id ?? await currentProgramYear(tx, p.tenant_id), team?.team_id ?? null,
        ids.asmId, ids.scrId, ids.hgaId, ids.recId, window?.schedule_id ?? null],
    )).rows[0];
    if (window) {
      await tx.query('update reassessment_schedule set actual_instance_id = $2 where schedule_id = $1', [window.schedule_id, inst.instance_id]);
    }
    await audit(tx, { tenantId: p.tenant_id, userId, action: 'create', recordType: 'assessment_instance', recordId: inst.instance_id,
      newValue: { ...ids, reassessment: Boolean(window) } });
    return inst;
  });
}

export type RawForm = Record<string, string | string[] | undefined>;

export interface StoredResponse { item_code: string; response_state: string; option_code: string | null; option_codes: string[] | null }

export async function loadResponses(tx: Tx, instanceId: string): Promise<Responses> {
  const rows = (await tx.query<StoredResponse>('select item_code, response_state, option_code, option_codes from item_response where instance_id = $1', [instanceId])).rows;
  return Object.fromEntries(rows.map((r) => [r.item_code, {
    state: r.response_state as Responses[string]['state'],
    optionCode: r.option_code ?? undefined,
    optionCodes: r.option_codes ?? undefined,
  }]));
}

/** Saves answers as a draft. Runs as the athlete, so the database refuses edits after the lock. */
export async function saveDraft(db: Db, userId: string, instanceId: string, form: RawForm, onlyItems?: string[]) {
  const row = (await db.system((tx) => tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1', [instanceId]))).rows[0];
  if (!row) throw new PermissionError('Assessment not found.');
  const asm = (await db.system((tx) => loadRuleSet(tx, ruleIdsOf(row)))).asm;
  await requireAck(db, userId);

  return db.asUser(userId, async (tx) => {
    const inst = (await tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1', [instanceId])).rows[0];
    if (!inst) throw new PermissionError('Assessment not found.');
    if (!['Not Started', 'In Progress'].includes(inst.status)) throw new PermissionError('This assessment was submitted and is locked.');
    const errors: Record<string, string> = {};
    // A page saves only its own items, so other Parts keep their answers.
    for (const item of asm.items.filter((i) => !onlyItems || onlyItems.includes(i.itemCode))) {
      const r = normalizeAnswer(item, form[item.itemCode] as string | string[] | undefined);
      const problem = checkResponse(item, r);
      if (problem) { errors[item.itemCode] = problem; continue; }
      await tx.query(
        `insert into item_response (instance_id, tenant_id, item_code, response_state, option_code, option_codes, updated_at)
         values ($1, $2, $3, $4, $5, $6, now())
         on conflict (instance_id, item_code) do update set response_state = excluded.response_state, option_code = excluded.option_code,
           option_codes = excluded.option_codes, updated_at = now()`,
        [instanceId, inst.tenant_id, item.itemCode, r.state, r.optionCode ?? null, r.optionCodes ?? null],
      );
    }
    await tx.query(
      `update assessment_instance set status = 'In Progress', last_saved_at = now(),
         started_at = coalesce(started_at, now()),
         draft_expires_at = coalesce(draft_expires_at, now() + make_interval(days => coalesce((select draft_days from privacy_config where tenant_id = $3), $2)))
       where instance_id = $1`, [instanceId, DRAFT_DAYS, inst.tenant_id],
    );
    if (inst.status === 'Not Started') {
      await audit(tx, { tenantId: inst.tenant_id, userId, action: 'status_change', recordType: 'assessment_instance', recordId: instanceId,
        oldValue: { status: 'Not Started' }, newValue: { status: 'In Progress' } });
    }
    return { errors };
  });
}

export type SubmitResult =
  | { ok: true; status: 'Complete / Scored' | 'Revalidated' }
  | { ok: false; statusLabel: string; missingItems: string[]; invalidItems: string[] };

/** Submit -> Validation Check -> (lock + score + HGA + Suggested IHS) or back to the athlete with what is missing. */
export async function submitAssessment(db: Db, userId: string, instanceId: string, form?: RawForm): Promise<SubmitResult> {
  if (form) await saveDraft(db, userId, instanceId, form);
  await requireAck(db, userId);
  // Ownership and editability are checked as the athlete (row-level security).
  const own = await db.asUser(userId, (tx) =>
    tx.query<InstanceRow>(`select * from assessment_instance where instance_id = $1 and status in ('Not Started', 'In Progress')`, [instanceId]));
  if (!own.rows[0]) throw new PermissionError('This assessment cannot be submitted.');

  return db.system(async (tx) => {
    const inst = (await tx.query<InstanceRow>('select * from assessment_instance where instance_id = $1 for update', [instanceId])).rows[0];
    await setStatus(tx, inst, 'Submitted', userId, ', submitted_at = now()');
    await setStatus(tx, inst, 'Validation Check', null);
    return scoreInstance(tx, inst, userId);
  });
}

/** Server-side pipeline (Milestone 3 Section 1.2). Also used to re-run an old record for reproduction. */
export async function scoreInstance(tx: Tx, inst: InstanceRow, actorUserId: string | null,
  mode: 'submit' | 'revalidate' = 'submit'): Promise<SubmitResult> {
  const rules: RuleSet = await loadRuleSet(tx, ruleIdsOf(inst));
  const responses = await loadResponses(tx, inst.instance_id);
  const score = scoreAssessment(rules.asm, rules.scoring, responses);

  const outcome = score.status === 'scored' ? 'Passed' : score.statusLabel;
  await tx.query(
    `insert into validation_result (instance_id, tenant_id, outcome, missing_items, invalid_items, c4_applicable_count) values ($1, $2, $3, $4, $5, $6)`,
    [inst.instance_id, inst.tenant_id, outcome, score.missingItems, score.invalidItems, score.c4ApplicableCount],
  );

  if (score.status !== 'scored') {
    // No partial HGI. The response set is not locked, so the athlete can complete it.
    await tx.query(
      `insert into hgi_result (instance_id, tenant_id, status, scr_version_id) values ($1, $2, $3, $4)
       on conflict (instance_id) do update set hgi_internal = null, hgi_display = null, band = null, status = excluded.status, calculated_at = now()`,
      [inst.instance_id, inst.tenant_id, score.status === 'incomplete' ? 'Incomplete' : 'Insufficient Data', rules.scrId],
    );
    await audit(tx, { tenantId: inst.tenant_id, userId: null, action: 'validation_failed', recordType: 'assessment_instance', recordId: inst.instance_id,
      newValue: { outcome, missing: score.missingItems, invalid: score.invalidItems }, ruleVersionId: rules.scrId });
    if (mode === 'submit') await setStatus(tx, inst, 'In Progress', null);
    return { ok: false, statusLabel: score.statusLabel, missingItems: score.missingItems, invalidItems: score.invalidItems };
  }

  // Lock, then store item points, category scores and HGI with the Scoring version.
  await tx.query('update assessment_instance set locked_at = now(), validated_at = now() where instance_id = $1', [inst.instance_id]);
  for (const it of score.items) {
    await tx.query('update item_response set points = $3 where instance_id = $1 and item_code = $2', [inst.instance_id, it.itemCode, it.points]);
  }
  await tx.query('delete from category_score where instance_id = $1', [inst.instance_id]);
  for (const c of score.categories) {
    await tx.query(
      `insert into category_score (instance_id, tenant_id, category, raw_score, applicable_max, applicable_count, score_internal, score_display, percent_internal, status, scr_version_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [inst.instance_id, inst.tenant_id, c.category, c.raw, c.applicableMax, c.applicableCount, c.internal, c.display, c.percent, c.status, rules.scrId],
    );
  }
  await tx.query(
    `insert into hgi_result (instance_id, tenant_id, hgi_internal, hgi_display, band, status, scr_version_id) values ($1, $2, $3, $4, $5, 'Calculated', $6)
     on conflict (instance_id) do update set hgi_internal = excluded.hgi_internal, hgi_display = excluded.hgi_display, band = excluded.band,
       status = 'Calculated', scr_version_id = excluded.scr_version_id, calculated_at = now()`,
    [inst.instance_id, inst.tenant_id, score.hgi!.internal, score.hgi!.display, score.hgi!.band, rules.scrId],
  );
  await audit(tx, { tenantId: inst.tenant_id, userId: null, action: 'scored', recordType: 'assessment_instance', recordId: inst.instance_id,
    newValue: { hgi: score.hgi }, ruleVersionId: rules.scrId });

  // HGA with the institution context recorded for the athlete's team.
  const team = inst.team_id
    ? (await tx.query<{ heat_safety_procedures: 'exist' | 'none' | 'unknown' }>('select heat_safety_procedures from team where team_id = $1', [inst.team_id])).rows[0]
    : undefined;
  const hga = runHga(rules.asm, rules.scoring, rules.hga, responses, score, { heatSafetyProcedures: team?.heat_safety_procedures ?? 'unknown' },
    await priorFindingsFor(tx, inst.instance_id));
  const findingIds = new Map<string, string>();
  for (const f of hga.findings) {
    const id = (await tx.query<{ finding_id: string }>(
      `insert into hga_finding (instance_id, tenant_id, rule_id, rule_version_id, finding_type, title, category, source_class, priority_class, rank, is_safety, input_refs)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning finding_id`,
      [inst.instance_id, inst.tenant_id, f.ruleId, rules.hgaId, f.level, f.title, f.tieBreakCategory, f.source, f.priority, f.rank, f.isSafety, JSON.stringify(f.inputs)],
    )).rows[0].finding_id;
    findingIds.set(f.ruleId, id);
  }
  for (const s of hga.strengths) {
    await tx.query(
      `insert into hga_finding (instance_id, tenant_id, rule_id, rule_version_id, finding_type, title, category, input_refs)
       values ($1, $2, 'HGA-S', $3, 'strength', $4, $5, $6)`,
      [inst.instance_id, inst.tenant_id, rules.hgaId, `Strength: ${s.name}`, s.category, JSON.stringify({ [`${s.category}%`]: s.percent })],
    );
  }
  await tx.query(
    `insert into hga_run (instance_id, tenant_id, hga_version_id, notes, hydration_profile) values ($1, $2, $3, $4, $5)
     on conflict (instance_id) do update set hga_version_id = excluded.hga_version_id, notes = excluded.notes,
       hydration_profile = excluded.hydration_profile, ran_at = now()`,
    [inst.instance_id, inst.tenant_id, rules.hgaId, JSON.stringify(hga.notes), JSON.stringify(buildProfile(rules.asm, responses, hga))],
  );
  await audit(tx, { tenantId: inst.tenant_id, userId: null, action: 'hga_evaluated', recordType: 'assessment_instance', recordId: inst.instance_id,
    newValue: { findings: hga.findings.map((f) => f.ruleId), strengths: hga.strengths.map((s) => s.category), notes: hga.notes }, ruleVersionId: rules.hgaId });

  // Suggested IHS: never visible to the athlete until approved and released.
  // After a correction the new IHS supersedes the earlier one; it never overwrites it (LFC-019).
  const previous = (await tx.query<{ ihs_id: string }>(
    'select ihs_id from ihs where instance_id = $1 and superseded_at is not null order by superseded_at desc limit 1', [inst.instance_id])).rows[0];
  const ihsId = (await tx.query<{ ihs_id: string }>(
    'insert into ihs (instance_id, tenant_id, participant_id, supersedes_id) values ($1, $2, $3, $4) returning ihs_id',
    [inst.instance_id, inst.tenant_id, inst.participant_id, previous?.ihs_id ?? null],
  )).rows[0].ihs_id;
  for (const s of suggestRecommendations(rules.rec, hga.findings)) {
    await tx.query(
      `insert into recommendation (ihs_id, instance_id, tenant_id, finding_id, entry_id, pathway, also_available, audience, reassessment_target, rank, is_safety, rec_version_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [ihsId, inst.instance_id, inst.tenant_id, findingIds.get(s.ruleId), s.entryId, s.pathway, s.alsoAvailable, s.audience, s.reassessmentTarget, s.rank, s.isSafety, rules.recId],
    );
  }
  await audit(tx, { tenantId: inst.tenant_id, userId: null, action: 'ihs_suggested', recordType: 'ihs', recordId: ihsId, ruleVersionId: rules.recId });

  // Baseline: the first accepted valid assessment in the Program Year (REA-004).
  const hasBaseline = (await tx.query(
    `select 1 from assessment_instance where participant_id = $1 and program_year_id = (select program_year_id from assessment_instance where instance_id = $2)
     and is_baseline and instance_id <> $2`, [inst.participant_id, inst.instance_id],
  )).rows.length > 0;
  // Safety findings are routed for priority review (IHS-008): reviewers and assigned health support are
  // alerted. The alert carries no symptom detail.
  if (hga.findings.some((f) => f.isSafety)) await safetyAlert(tx, inst);

  const final = mode === 'revalidate' ? 'Revalidated' : 'Complete / Scored';
  const isReassessment = Boolean((await tx.query<{ schedule_id: string | null }>(
    'select schedule_id from assessment_instance where instance_id = $1', [inst.instance_id])).rows[0]?.schedule_id);
  await setStatus(tx, inst, final, actorUserId, hasBaseline || isReassessment ? '' : ', is_baseline = true');
  // Reassessment: close the window and store the change since baseline (Document #4).
  await afterScored(tx, inst.instance_id);
  return { ok: true, status: final };
}

async function safetyAlert(tx: Tx, inst: InstanceRow) {
  const to = (await tx.query<{ email: string }>(
    `select distinct u.email from role_assignment ra join app_user u using (user_id)
     where ra.tenant_id = $1 and u.status = 'Active' and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
       and (ra.role = 'program_admin'
         or (ra.role = 'health_support' and (ra.scope_type = 'tenant' or (ra.scope_type = 'athlete' and ra.scope_id = $2)
           or (ra.scope_type = 'team' and exists (select 1 from athlete_team_affiliation a where a.participant_id = $2 and a.team_id = ra.scope_id
                 and a.effective_start <= current_date and (a.effective_end is null or a.effective_end >= current_date))))))`,
    [inst.tenant_id, inst.participant_id],
  )).rows;
  const code = (await tx.query<{ athlete_code: string }>('select athlete_code from participant where participant_id = $1', [inst.participant_id])).rows[0].athlete_code;
  for (const r of to) {
    await sendEmail(tx, r.email, 'Priority review: safety finding',
      [`A submitted Structured Hydration Assessment (Athlete ID ${code}) has a safety finding that needs priority review`,
        'under the approved athletic-training / health-support process.', '', 'Please sign in to the review queue. No details are included in this email.'].join('\n'));
  }
  await audit(tx, { tenantId: inst.tenant_id, action: 'safety_alert_sent', recordType: 'assessment_instance', recordId: inst.instance_id,
    newValue: { recipients: to.length } });
}

// ---------- Athlete views ----------
export async function athleteHome(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => {
    const inst = (await tx.query<InstanceRow & { last_saved_at: string | null }>(
      `select i.* from assessment_instance i join participant p using (participant_id)
       where p.user_id = app_uid() and i.status <> 'Expired' order by i.started_at desc nulls first limit 1`,
    )).rows[0];
    const profile = (await tx.query<{ first_name: string; athlete_code: string; participant_id: string }>(
      `select ap.first_name, p.athlete_code, p.participant_id from participant p join athlete_profile ap using (participant_id) where p.user_id = app_uid()`,
    )).rows[0];
    const window = profile ? (await tx.query<{ target_start: string; target_end: string }>(
      `select target_start::text, target_end::text from reassessment_schedule where participant_id = $1 and outcome = 'Scheduled'
       and target_start <= current_date and target_end >= current_date`, [profile.participant_id])).rows[0] ?? null : null;
    return { instance: inst ?? null, profile: profile ?? null, window };
  });
}

/** Only approved and released content: HGI, band, strengths, priorities and Hydration Action Items.
 *  No rule IDs, weights, formulas, internal notes or other athletes' data. */
export async function athleteResult(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => {
    const inst = (await tx.query<InstanceRow>(
      `select i.* from assessment_instance i join participant p using (participant_id)
       where p.user_id = app_uid() and i.status = 'Released' order by i.released_at desc limit 1`,
    )).rows[0];
    if (!inst) return null;
    const hgi = (await tx.query<{ hgi_display: string; band: string }>('select hgi_display, band from hgi_result where instance_id = $1', [inst.instance_id])).rows[0];
    const findings = (await tx.query<{ finding_id: string; title: string; source_class: string; finding_type: string; is_safety: boolean }>(
      `select finding_id, title, source_class, finding_type, is_safety from hga_finding where instance_id = $1 and superseded_at is null order by finding_type = 'strength', rank`, [inst.instance_id],
    )).rows;
    const actions = (await tx.query<{ action_item_id: string; status: string; pathway: string; athlete_text: string; finding_id: string; reassessment_target: string }>(
      `select a.action_item_id, a.status, r.pathway, e.athlete_text, r.finding_id, r.reassessment_target
       from action_item a join recommendation r using (rec_id) join rec_library_entry e using (entry_id)
       where r.instance_id = $1 and r.superseded_at is null and a.superseded_at is null order by r.rank`, [inst.instance_id],
    )).rows;
    const approvedFindingIds = new Set((await tx.query<{ finding_id: string }>(
      `select finding_id from recommendation where instance_id = $1 and superseded_at is null`, [inst.instance_id])).rows.map((r) => r.finding_id));
    return {
      releasedAt: inst.released_at,
      hgiDisplay: hgi ? Number(hgi.hgi_display).toFixed(1) : null,
      band: hgi?.band ?? null,
      strengths: findings.filter((f) => f.finding_type === 'strength').map((f) => f.title.replace(/^Strength: /, '')),
      // Priorities = findings whose recommendation was approved and released to the athlete.
      priorities: findings.filter((f) => f.finding_type !== 'strength' && approvedFindingIds.has(f.finding_id))
        .map((f) => ({ title: f.title, source: f.source_class, isSafety: f.is_safety })),
      actionItems: actions,
    };
  });
}

export async function completeActionItem(db: Db, userId: string, actionItemId: string) {
  return db.asUser(userId, async (tx) => {
    const r = await tx.query<{ tenant_id: string }>(
      `update action_item set status = 'Completed / Implemented', completed_at = now()
       where action_item_id = $1 and status = 'Assigned / Delivered' and superseded_at is null returning tenant_id`, [actionItemId],
    );
    if (!r.rows[0]) throw new PermissionError('Action item not found.');
    // Completion is recorded only; it never changes a finding to Improved or Resolved (IHS-016).
    await audit(tx, { tenantId: r.rows[0].tenant_id, userId, action: 'action_item_completed', recordType: 'action_item', recordId: actionItemId });
  });
}

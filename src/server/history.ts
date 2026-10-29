// Administration search, assessment history / trend, team transfers, duplicate resolution and
// explicit access grants (contract Week 5; Document #4 REA-011/017/018; Document #7 LFC-025..032; Document #6 ROL-003/014).
// Every read runs as the signed-in user, so row-level security decides who sees which athlete.
import type { Db } from './db';
import { audit } from './audit';
import { PermissionError, requireAdmin } from './roster';
import { OUTCOME_UNKNOWN, SCORED } from './reassessment';

export interface AthleteFilters {
  q?: string;
  tenantId?: string;
  teamId?: string;
  status?: string; // latest assessment status, or 'none'
  band?: string;
  safety?: 'yes';
  reassessment?: 'open' | 'unknown' | 'completed' | 'none';
}

export interface AthleteRow {
  participant_id: string;
  athlete_code: string;
  first_name: string;
  last_name: string;
  email: string;
  institution: string;
  tenant_id: string;
  teams: string | null;
  latest_status: string | null;
  latest_hgi: string | null;
  latest_band: string | null;
  baseline_hgi: string | null;
  hgi_change: string | null;
  comparison_status: string | null;
  scored_count: number;
  safety: number;
  window_start: string | null;
  window_end: string | null;
  last_outcome: string | null;
}

export async function searchAthletes(db: Db, userId: string, f: AthleteFilters = {}) {
  const rows = await db.asUser(userId, (tx) => tx.query<AthleteRow>(
    `select p.participant_id, p.athlete_code, ap.first_name, ap.last_name, ap.email, t.display_name as institution, p.tenant_id,
            (select string_agg(tm.name, ', ' order by tm.name) from athlete_team_affiliation a join team tm using (team_id)
              where a.participant_id = p.participant_id and a.effective_start <= current_date
                and (a.effective_end is null or a.effective_end >= current_date)) as teams,
            li.status as latest_status, h.hgi_display::text as latest_hgi, h.band as latest_band,
            (select hb.hgi_display::text from assessment_instance b join hgi_result hb using (instance_id)
              where b.participant_id = p.participant_id and b.is_baseline order by b.submitted_at desc limit 1) as baseline_hgi,
            ca.hgi_change::text as hgi_change, ca.comparison_status,
            (select count(*)::int from assessment_instance x where x.participant_id = p.participant_id and x.status = any($1)) as scored_count,
            (select count(*)::int from hga_finding fx where fx.instance_id = li.instance_id and fx.is_safety and fx.superseded_at is null) as safety,
            os.target_start::text as window_start, os.target_end::text as window_end,
            (select s2.outcome from reassessment_schedule s2 where s2.participant_id = p.participant_id and s2.outcome <> 'Scheduled'
              order by s2.closed_at desc nulls last limit 1) as last_outcome
     from participant p
       join athlete_profile ap using (participant_id)
       join tenant t on t.tenant_id = p.tenant_id
       left join lateral (select i.* from assessment_instance i where i.participant_id = p.participant_id and i.status <> 'Expired'
                          order by i.started_at desc nulls first limit 1) li on true
       left join hgi_result h on h.instance_id = li.instance_id
       left join change_analysis ca on ca.current_instance_id = li.instance_id and ca.superseded_at is null
       left join reassessment_schedule os on os.participant_id = p.participant_id and os.outcome = 'Scheduled'
     where p.status <> 'Merged'
       and ($2::text is null or ap.first_name || ' ' || ap.last_name ilike '%' || $2 || '%' or ap.email ilike '%' || $2 || '%' or p.athlete_code ilike '%' || $2 || '%')
       and ($3::uuid is null or p.tenant_id = $3)
       and ($4::uuid is null or exists (select 1 from athlete_team_affiliation a2 where a2.participant_id = p.participant_id and a2.team_id = $4
              and (a2.effective_end is null or a2.effective_end >= current_date)))
     order by safety desc, ap.last_name, ap.first_name`,
    [SCORED, f.q?.trim() || null, f.tenantId || null, f.teamId || null])).then((r) => r.rows);
  return rows.filter((r) =>
    (!f.status || (f.status === 'none' ? r.latest_status == null : r.latest_status === f.status))
    && (!f.band || r.latest_band === f.band)
    && (!f.safety || r.safety > 0)
    && (!f.reassessment
      || (f.reassessment === 'open' && r.window_end != null)
      || (f.reassessment === 'unknown' && r.window_end == null && r.last_outcome === OUTCOME_UNKNOWN)
      || (f.reassessment === 'completed' && r.window_end == null && r.last_outcome === 'Completed')
      || (f.reassessment === 'none' && r.window_end == null && r.last_outcome == null)));
}

/** Filter choices limited to what the user may see. */
export async function athleteFilterOptions(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => ({
    tenants: (await tx.query<{ tenant_id: string; display_name: string }>(
      `select distinct t.tenant_id, t.display_name from tenant t join participant p on p.tenant_id = t.tenant_id order by t.display_name`)).rows,
    teams: (await tx.query<{ team_id: string; name: string; institution: string }>(
      `select tm.team_id, tm.name, t.display_name as institution from team tm join tenant t using (tenant_id) order by t.display_name, tm.name`)).rows,
  }));
}

// ---------- Assessment history / trend for one athlete ----------
export async function athleteHistory(db: Db, userId: string, participantId: string) {
  return db.asUser(userId, async (tx) => {
    const profile = (await tx.query<{ participant_id: string; athlete_code: string; status: string; first_name: string; last_name: string; email: string;
      institution_athlete_id: string | null; institution: string; tenant_id: string; is_admin: boolean }>(
      `select p.participant_id, p.athlete_code, p.status, ap.first_name, ap.last_name, ap.email, ap.institution_athlete_id,
              t.display_name as institution, p.tenant_id, app_is_admin(p.tenant_id) as is_admin
       from participant p join athlete_profile ap using (participant_id) join tenant t on t.tenant_id = p.tenant_id
       where p.participant_id = $1`, [participantId])).rows[0];
    if (!profile) return null;
    // Records linked as the same person (duplicate resolution) are shown together (LFC-032).
    const ids = [participantId, ...(await tx.query<{ participant_id: string }>(
      'select participant_id from participant where merged_into_id = $1', [participantId])).rows.map((r) => r.participant_id)];
    const q = <T>(sql: string, extra: unknown[] = []) => tx.query<T>(sql, [ids, ...extra]).then((r) => r.rows);

    const affiliations = await q<{ affiliation_id: string; team: string; team_id: string; effective_start: string; effective_end: string | null }>(
      `select a.affiliation_id, tm.name as team, a.team_id, a.effective_start::text, a.effective_end::text
       from athlete_team_affiliation a join team tm using (team_id) where a.participant_id = any($1) order by a.effective_start, tm.name`);
    const instances = await q<{ instance_id: string; status: string; is_baseline: boolean; started_at: string | null; submitted_at: string | null;
      released_at: string | null; team: string | null; asm_version_id: string; scr_version_id: string; hga_version_id: string;
      hgi_display: string | null; hgi_internal: string | null; band: string | null; safety: number; schedule_id: string | null }>(
      `select i.instance_id, i.status, i.is_baseline, i.started_at, i.submitted_at, i.released_at, tm.name as team,
              i.asm_version_id, i.scr_version_id, i.hga_version_id, h.hgi_display::text, h.hgi_internal::text, h.band,
              (select count(*)::int from hga_finding f where f.instance_id = i.instance_id and f.is_safety and f.superseded_at is null) as safety,
              i.schedule_id
       from assessment_instance i left join team tm on tm.team_id = i.team_id left join hgi_result h on h.instance_id = i.instance_id
       where i.participant_id = any($1) order by coalesce(i.submitted_at, i.started_at) nulls last`);
    const schedules = await q<{ schedule_id: string; target_start: string; target_end: string; outcome: string; actual_instance_id: string | null;
      submitted_at: string | null }>(
      `select s.schedule_id, s.target_start::text, s.target_end::text, s.outcome, s.actual_instance_id, i.submitted_at
       from reassessment_schedule s left join assessment_instance i on i.instance_id = s.actual_instance_id
       where s.participant_id = any($1) order by s.target_start`);
    const analyses = await q<{ change_analysis_id: string; current_instance_id: string; baseline_instance_id: string; comparison_status: string;
      hgi_baseline: string | null; hgi_current: string | null; hgi_change: string | null; category_changes: { category: string; baseline: string; current: string; changeDisplay: string }[];
      item_changes: { itemCode: string; baseline: string; current: string }[]; contextual_changes: { itemCode: string; baseline: string; current: string }[] }>(
      `select change_analysis_id, current_instance_id, baseline_instance_id, comparison_status, hgi_baseline::text, hgi_current::text, hgi_change::text,
              category_changes, item_changes, contextual_changes
       from change_analysis where participant_id = any($1) and superseded_at is null order by created_at`);
    const findingChanges = analyses.length ? await tx.query<{ change_analysis_id: string; rule_id: string; title: string; state: string; measure_label: string | null;
      baseline_measure: string | null; current_measure: string | null; source_class: string | null; priority_class: number | null; is_safety: boolean; is_contextual: boolean }>(
      `select change_analysis_id, rule_id, title, state, measure_label, baseline_measure::text, current_measure::text, source_class, priority_class, is_safety, is_contextual
       from finding_change where change_analysis_id = any($1)`, [analyses.map((a) => a.change_analysis_id)]).then((r) => r.rows) : [];
    const strengths = await q<{ instance_id: string; title: string }>(
      `select instance_id, replace(title, 'Strength: ', '') as title from hga_finding where instance_id in
         (select instance_id from assessment_instance where participant_id = any($1)) and finding_type = 'strength' and superseded_at is null`);
    // Intervention history between assessments (REA-011). Completion is not improvement (REA-012).
    const interventions = await q<{ action_item_id: string; instance_id: string; finding: string; pathway: string; audience: string; reassessment_target: string;
      status: string; assigned_at: string; completed_at: string | null; rec_version_id: string; superseded: boolean }>(
      `select a.action_item_id, r.instance_id, f.title as finding, r.pathway, r.audience, r.reassessment_target, a.status, a.assigned_at, a.completed_at,
              r.rec_version_id, (a.superseded_at is not null) as superseded
       from action_item a join recommendation r using (rec_id) join hga_finding f on f.finding_id = r.finding_id
       where a.participant_id = any($1) order by a.assigned_at`);
    const duplicates = profile.is_admin ? await tx.query<{ duplicate_review_id: string; reason: string; status: string; other_id: string; other_code: string; other_name: string }>(
      `select d.duplicate_review_id, d.reason, d.status,
              case when d.participant_id = $1 then d.candidate_participant_id else d.participant_id end as other_id,
              po.athlete_code as other_code, ao.first_name || ' ' || ao.last_name as other_name
       from duplicate_review d
         join participant po on po.participant_id = case when d.participant_id = $1 then d.candidate_participant_id else d.participant_id end
         join athlete_profile ao on ao.participant_id = po.participant_id
       where (d.participant_id = $1 or d.candidate_participant_id = $1) and d.status = 'Open'`, [participantId]).then((r) => r.rows) : [];
    const grants = profile.is_admin ? await tx.query<{ grant_id: string; staff: string; email: string; valid_to: string; reason: string; revoked_at: string | null; active: boolean }>(
      `select g.grant_id, u.display_name as staff, u.email, g.valid_to, g.reason, g.revoked_at,
              (g.revoked_at is null and g.valid_to > now() and g.valid_from <= now()) as active
       from access_grant g join app_user u on u.user_id = g.user_id where g.participant_id = $1 order by g.created_at desc`, [participantId]).then((r) => r.rows) : [];
    const grantable = profile.is_admin ? await tx.query<{ user_id: string; display_name: string; role: string }>(
      `select distinct u.user_id, u.display_name, ra.role from role_assignment ra join app_user u using (user_id)
       where ra.tenant_id = $1 and ra.role in ('coach', 'inst_leader', 'health_support') and (ra.valid_to is null or ra.valid_to > now())
       order by u.display_name`, [profile.tenant_id]).then((r) => r.rows) : [];
    const teams = profile.is_admin ? await tx.query<{ team_id: string; name: string }>(
      'select team_id, name from team where tenant_id = $1 order by name', [profile.tenant_id]).then((r) => r.rows) : [];
    return { profile, affiliations, instances, schedules, analyses, findingChanges, strengths, interventions, duplicates, grants, grantable, teams };
  });
}

// ---------- Team transfer (REA-017/018, LFC-026): history stays with the earlier team ----------
export async function transferAthlete(db: Db, adminUserId: string, participantId: string, newTeamId: string, effectiveDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new PermissionError('Please choose the date the move takes effect.');
  return db.system(async (tx) => {
    const p = (await tx.query<{ tenant_id: string }>('select tenant_id from participant where participant_id = $1', [participantId])).rows[0];
    if (!p) throw new PermissionError('Athlete not found.');
    await requireAdmin(tx, adminUserId, p.tenant_id);
    const team = (await tx.query('select 1 from team where team_id = $1 and tenant_id = $2', [newTeamId, p.tenant_id])).rows.length;
    if (!team) throw new PermissionError('That team does not belong to this institution.');
    const current = (await tx.query<{ affiliation_id: string; team_id: string; effective_start: string }>(
      `select affiliation_id, team_id, effective_start::text from athlete_team_affiliation
       where participant_id = $1 and (effective_end is null or effective_end >= $2::date)`, [participantId, effectiveDate])).rows;
    if (current.some((a) => a.team_id === newTeamId)) throw new PermissionError('The athlete is already on that team.');
    if (current.some((a) => a.effective_start >= effectiveDate)) throw new PermissionError('The move must take effect after the current team start date.');
    await tx.query(`update athlete_team_affiliation set effective_end = $2::date - 1 where participant_id = $1 and (effective_end is null or effective_end >= $2::date)`,
      [participantId, effectiveDate]);
    await tx.query('insert into athlete_team_affiliation (tenant_id, participant_id, team_id, effective_start) values ($1, $2, $3, $4)',
      [p.tenant_id, participantId, newTeamId, effectiveDate]);
    await audit(tx, { tenantId: p.tenant_id, userId: adminUserId, action: 'team_transfer', recordType: 'participant', recordId: participantId,
      oldValue: { teams: current.map((a) => a.team_id) }, newValue: { team: newTeamId, effectiveDate } });
  });
}

// ---------- Duplicate resolution (LFC-029..032, AUD-103): Identify -> Review -> Link -> Preserve history ----------
export async function resolveDuplicate(db: Db, adminUserId: string, reviewId: string, decision: 'different' | 'link', reason: string) {
  if (!reason?.trim()) throw new PermissionError('A reason is required.');
  return db.system(async (tx) => {
    const d = (await tx.query<{ tenant_id: string; participant_id: string; candidate_participant_id: string; status: string }>(
      'select tenant_id, participant_id, candidate_participant_id, status from duplicate_review where duplicate_review_id = $1 for update', [reviewId])).rows[0];
    if (!d) throw new PermissionError('Review not found.');
    await requireAdmin(tx, adminUserId, d.tenant_id);
    if (d.status !== 'Open') throw new PermissionError('This review was already resolved.');
    if (decision === 'different') {
      await tx.query(`update duplicate_review set status = 'Confirmed Different', resolved_by = $2, resolved_at = now() where duplicate_review_id = $1`, [reviewId, adminUserId]);
    } else {
      // The newer record is linked into the existing one. Nothing is deleted or moved: every assessment,
      // affiliation and audit row stays where it is and is shown on the surviving record.
      const survivor = d.candidate_participant_id;
      const merged = d.participant_id;
      await tx.query(`update participant set status = 'Merged', merged_into_id = $2 where participant_id = $1`, [merged, survivor]);
      await tx.query(`update app_user set status = 'Deactivated' where user_id = (select user_id from participant where participant_id = $1)`, [merged]);
      await tx.query(`update reassessment_schedule set outcome = 'Cancelled', closed_at = now() where participant_id = $1 and outcome = 'Scheduled'`, [merged]);
      await tx.query(`update duplicate_review set status = 'Linked', resolved_by = $2, resolved_at = now() where duplicate_review_id = $1`, [reviewId, adminUserId]);
    }
    await audit(tx, { tenantId: d.tenant_id, userId: adminUserId, action: decision === 'link' ? 'duplicate_linked' : 'duplicate_confirmed_different',
      recordType: 'duplicate_review', recordId: reviewId, oldValue: { participant: d.participant_id, candidate: d.candidate_participant_id }, reason: reason.trim() });
  });
}

// ---------- Explicit, time-limited individual access (ROL-003, ROL-014, ROL-016) ----------
export async function grantAccess(db: Db, adminUserId: string, participantId: string, staffUserId: string, until: string, reason: string) {
  if (!reason?.trim()) throw new PermissionError('A reason is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new PermissionError('Please choose an end date.');
  return db.system(async (tx) => {
    const p = (await tx.query<{ tenant_id: string }>('select tenant_id from participant where participant_id = $1', [participantId])).rows[0];
    if (!p) throw new PermissionError('Athlete not found.');
    await requireAdmin(tx, adminUserId, p.tenant_id);
    const staff = (await tx.query(
      `select 1 from role_assignment where user_id = $1 and tenant_id = $2 and role in ('coach', 'inst_leader', 'health_support')
       and (valid_to is null or valid_to > now())`, [staffUserId, p.tenant_id])).rows.length;
    if (!staff) throw new PermissionError('Access can only be granted to staff of this institution.');
    const r = await tx.query<{ grant_id: string; valid_to: string }>(
      `insert into access_grant (tenant_id, user_id, participant_id, approved_by, valid_to, reason)
       values ($1, $2, $3, $4, ($5::date + 1)::timestamptz, $6) returning grant_id, valid_to`,
      [p.tenant_id, staffUserId, participantId, adminUserId, until, reason.trim()]);
    if (new Date(r.rows[0].valid_to) <= new Date()) throw new PermissionError('The end date must be in the future.');
    await audit(tx, { tenantId: p.tenant_id, userId: adminUserId, action: 'access_granted', recordType: 'access_grant', recordId: r.rows[0].grant_id,
      newValue: { staffUserId, participantId, until }, reason: reason.trim() });
  });
}

export async function revokeAccess(db: Db, adminUserId: string, grantId: string) {
  return db.system(async (tx) => {
    const g = (await tx.query<{ tenant_id: string }>('select tenant_id from access_grant where grant_id = $1 and revoked_at is null', [grantId])).rows[0];
    if (!g) throw new PermissionError('Grant not found.');
    await requireAdmin(tx, adminUserId, g.tenant_id);
    await tx.query('update access_grant set revoked_at = now(), revoked_by = $2 where grant_id = $1', [grantId, adminUserId]);
    await audit(tx, { tenantId: g.tenant_id, userId: adminUserId, action: 'access_revoked', recordType: 'access_grant', recordId: grantId });
  });
}

/** Change since baseline for one reassessment (review page). */
export async function changeFor(db: Db, userId: string, instanceId: string) {
  return db.asUser(userId, async (tx) => {
    const ca = (await tx.query<{ change_analysis_id: string; comparison_status: string; hgi_baseline: string | null; hgi_current: string | null; hgi_change: string | null; participant_id: string }>(
      `select change_analysis_id, comparison_status, hgi_baseline::text, hgi_current::text, hgi_change::text, participant_id
       from change_analysis where current_instance_id = $1 and superseded_at is null`, [instanceId])).rows[0];
    if (!ca) return null;
    const findings = (await tx.query<{ rule_id: string; title: string; state: string; is_safety: boolean; is_contextual: boolean }>(
      `select rule_id, title, state, is_safety, is_contextual from finding_change where change_analysis_id = $1
       order by (is_safety and state <> 'Resolved') desc, case state when 'New' then 0 when 'Worsened' then 1 when 'Persistent' then 2 when 'Improved' then 3 else 4 end, rule_id`,
      [ca.change_analysis_id])).rows;
    return { ...ca, findings };
  });
}

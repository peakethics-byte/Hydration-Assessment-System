// Read models for the administration and staff screens. All run as the signed-in user (RLS applies).
import type { Db } from './db';

export async function adminOverview(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => {
    const teams = (await tx.query<{ team_id: string; tenant_id: string; name: string; institution: string; heat_safety_procedures: string;
      listed: number; invited: number; link_sent: number; registered: number }>(
      `select t.team_id, t.tenant_id, t.name, tn.display_name as institution, t.heat_safety_procedures,
              count(r.*) filter (where r.status = 'Listed')::int as listed,
              count(r.*) filter (where r.status = 'Invited')::int as invited,
              count(r.*) filter (where r.status = 'Link Sent')::int as link_sent,
              count(r.*) filter (where r.status = 'Registered')::int as registered
       from team t join tenant tn on tn.tenant_id = t.tenant_id left join roster_entry r on r.team_id = t.team_id
       where app_is_admin(t.tenant_id) group by t.team_id, tn.display_name order by tn.display_name, t.name`,
    )).rows;
    const roster = (await tx.query<{ roster_entry_id: string; team_id: string; first_name: string; last_name: string; email_normalized: string; status: string; athlete_code: string | null }>(
      `select r.roster_entry_id, r.team_id, r.first_name, r.last_name, r.email_normalized, r.status, p.athlete_code
       from roster_entry r left join participant p using (participant_id) order by r.last_name, r.first_name`,
    )).rows;
    const duplicates = (await tx.query<{ duplicate_review_id: string; reason: string; status: string; a_code: string; a_name: string; b_code: string; b_name: string }>(
      `select d.duplicate_review_id, d.reason, d.status, pa.athlete_code as a_code, a.first_name || ' ' || a.last_name as a_name,
              pb.athlete_code as b_code, b.first_name || ' ' || b.last_name as b_name
       from duplicate_review d join participant pa on pa.participant_id = d.participant_id join athlete_profile a on a.participant_id = d.participant_id
         join participant pb on pb.participant_id = d.candidate_participant_id join athlete_profile b on b.participant_id = d.candidate_participant_id
       where d.status = 'Open'`,
    )).rows;
    const expired = (await tx.query<{ instance_id: string; athlete_code: string; first_name: string; last_name: string; last_saved_at: string | null }>(
      `select i.instance_id, p.athlete_code, ap.first_name, ap.last_name, i.last_saved_at
       from assessment_instance i join participant p using (participant_id) join athlete_profile ap using (participant_id)
       where i.status = 'Expired' and app_is_admin(i.tenant_id) order by i.last_saved_at desc`,
    )).rows;
    const privacy = (await tx.query<{ tenant_id: string; institution: string; ack_required: boolean; ack_document_version_id: string | null; draft_days: number }>(
      `select pc.tenant_id, t.display_name as institution, pc.ack_required, pc.ack_document_version_id, pc.draft_days
       from privacy_config pc join tenant t using (tenant_id) where app_is_admin(pc.tenant_id) order by t.display_name`,
    )).rows;
    return { teams, roster, duplicates, expired, privacy };
  });
}

/** Participation gating is a configurable setting (LFC-036); wording comes from WeCanH2O. */
export async function setAckRequired(db: Db, userId: string, tenantId: string, required: boolean) {
  const ok = await db.asUser(userId, async (tx) => {
    const r = await tx.query('update privacy_config set ack_required = $2, updated_by = app_uid(), updated_at = now() where tenant_id = $1 and app_is_admin(tenant_id)',
      [tenantId, required]);
    if (!r.affectedRows) return false;
    await tx.query(`insert into audit_event (tenant_id, user_id, action, record_type, record_id, new_value)
      values ($1, app_uid(), 'update', 'privacy_config', $1, $2)`, [tenantId, JSON.stringify({ ackRequired: required })]);
    return true;
  });
  if (!ok) throw new Error('You do not have permission for this action.');
}

export async function auditLog(db: Db, userId: string, limit = 200) {
  return db.asUser(userId, (tx) => tx.query<{ event_id: string; created_at: string; action: string; record_type: string; record_id: string | null;
    actor: string | null; old_value: unknown; new_value: unknown; reason: string | null; rule_version_id: string | null }>(
    `select e.event_id, e.created_at, e.action, e.record_type, e.record_id, u.display_name as actor, e.old_value, e.new_value, e.reason, e.rule_version_id
     from audit_event e left join app_user u on u.user_id = e.user_id order by e.event_id desc limit $1`, [limit],
  )).then((r) => r.rows);
}

/** Health support: assigned athletes only. Coaches and leaders: no individual rows by default. */
export async function staffOverview(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => {
    const athletes = (await tx.query<{ participant_id: string; athlete_code: string; first_name: string; last_name: string; status: string | null; hgi_display: string | null; band: string | null; safety: number }>(
      `select p.participant_id, p.athlete_code, ap.first_name, ap.last_name, i.status, h.hgi_display, h.band,
              (select count(*)::int from hga_finding f where f.instance_id = i.instance_id and f.is_safety and f.superseded_at is null) as safety
       from participant p join athlete_profile ap using (participant_id)
         left join lateral (select * from assessment_instance x where x.participant_id = p.participant_id and x.status <> 'Expired'
                            order by x.started_at desc nulls first limit 1) i on true
         left join hgi_result h on h.instance_id = i.instance_id
       where p.status <> 'Merged'
       order by safety desc, ap.last_name`,
    )).rows;
    const teams = (await tx.query<{ name: string; institution: string }>(
      'select t.name, tn.display_name as institution from team t join tenant tn on tn.tenant_id = t.tenant_id order by t.name')).rows;
    return { athletes, teams };
  });
}

export interface UserRow {
  user_id: string;
  display_name: string;
  email: string;
  status: string;
  mfa_enrolled: boolean;
  role: string;
  institution: string;
  scope_type: string;
  scope_label: string | null;
  athlete_code: string | null;
  teams: string | null;
  can_export: boolean;
  role_assignment_id: string;
  tenant_id: string;
  setup_pending: boolean;
}

/** Read-only list of the people in the administrator's institutions (role_assignment RLS limits the rows). */
export async function userList(db: Db, userId: string) {
  return db.asUser(userId, (tx) => tx.query<UserRow>(
    `select u.user_id, u.display_name, u.email, u.status, u.mfa_enrolled, u.setup_pending, ra.role, t.display_name as institution,
            ra.scope_type, ra.can_export, ra.role_assignment_id, ra.tenant_id,
            case ra.scope_type when 'team' then (select name from team where team_id = ra.scope_id) else null end as scope_label,
            p.athlete_code,
            (select string_agg(tm.name, ', ' order by tm.name) from athlete_team_affiliation a join team tm using (team_id)
              where a.participant_id = p.participant_id and (a.effective_end is null or a.effective_end >= current_date)) as teams
     from role_assignment ra
       join app_user u on u.user_id = ra.user_id
       join tenant t on t.tenant_id = ra.tenant_id
       left join participant p on p.user_id = u.user_id and p.tenant_id = ra.tenant_id
     where app_is_admin(ra.tenant_id) and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
     order by t.display_name, case ra.role when 'program_admin' then 1 when 'health_support' then 2 when 'inst_leader' then 3
       when 'coach' then 4 else 5 end, u.display_name`,
  )).then((r) => r.rows);
}

/** Institutions and teams the administrator manages (for the "Add staff member" form). */
export async function adminScopes(db: Db, userId: string) {
  return db.asUser(userId, async (tx) => {
    const tenants = (await tx.query<{ tenant_id: string; display_name: string; tenant_kind: string }>(
      `select tenant_id, display_name, tenant_kind from tenant where app_is_admin(tenant_id) order by tenant_kind, display_name`)).rows;
    const teams = (await tx.query<{ team_id: string; tenant_id: string; name: string }>(
      `select team_id, tenant_id, name from team where app_is_admin(tenant_id) order by name`)).rows;
    return { tenants, teams };
  });
}

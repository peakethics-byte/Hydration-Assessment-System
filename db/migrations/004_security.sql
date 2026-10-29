-- 004 Row-level security (Milestone 2 Sections 4 and 6).
-- Every user request runs as database role app_rw with app.user_id set for the transaction, so the
-- database itself refuses cross-institution access and individual access the role does not allow.
-- The scoring/HGA pipeline runs as the owner only after the server has checked ownership.

create role app_rw nologin;

-- ---- Helper functions (security definer: they read role tables regardless of RLS) ----
create function app_uid() returns uuid language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app_has_role(t uuid, roles text[]) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from role_assignment ra
    where ra.user_id = app_uid() and ra.tenant_id = t and ra.role = any(roles)
      and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now()))
$$;

create function app_is_admin(t uuid) returns boolean language sql stable security definer as $$
  select app_has_role(t, array['program_admin'])
$$;

create function app_is_self(pid uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from participant p where p.participant_id = pid and p.user_id = app_uid())
$$;

-- Health support sees only assigned athletes (tenant-wide, team or single-athlete scope).
create function app_health_can(pid uuid) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from role_assignment ra join participant p on p.participant_id = pid
    where ra.user_id = app_uid() and ra.role = 'health_support' and ra.tenant_id = p.tenant_id
      and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
      and (ra.scope_type = 'tenant'
        or (ra.scope_type = 'athlete' and ra.scope_id = pid)
        or (ra.scope_type = 'team' and exists (
              select 1 from athlete_team_affiliation a
              where a.participant_id = pid and a.team_id = ra.scope_id
                and a.effective_start <= current_date and (a.effective_end is null or a.effective_end >= current_date)))))
$$;

-- Explicit, logged, time-limited grant (e.g. coach individual access).
create function app_has_grant(pid uuid) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from access_grant g
    where g.user_id = app_uid() and g.participant_id = pid and g.valid_from <= now() and g.valid_to > now())
$$;

create function app_staff_can_see(pid uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from participant p where p.participant_id = pid and app_is_admin(p.tenant_id))
    or app_health_can(pid) or app_has_grant(pid)
$$;

create function app_instance_released_to_self(iid uuid) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from assessment_instance i
    where i.instance_id = iid and app_is_self(i.participant_id) and i.status = 'Released')
$$;

create function app_instance_editable_by_self(iid uuid) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from assessment_instance i
    where i.instance_id = iid and app_is_self(i.participant_id)
      and i.status in ('Not Started', 'In Progress')
      and (i.draft_expires_at is null or i.draft_expires_at > now()))
$$;

create function app_instance_staff(iid uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from assessment_instance i where i.instance_id = iid and app_staff_can_see(i.participant_id))
$$;

-- ---- Grants ----
grant usage on schema public to app_rw;
grant select on population_module, rule_version, assessment_item, rec_library_entry, personal_data_field, ack_document_version to app_rw;
grant select on tenant, program_year, reporting_period, role_assignment, access_grant, participant, athletic_program, team,
  athlete_profile, athlete_team_affiliation, roster_entry, duplicate_review, assessment_instance, item_response,
  validation_result, category_score, hgi_result, hga_finding, hga_run, ihs, recommendation, action_item, audit_event to app_rw;
grant insert, update on item_response to app_rw;
grant update on assessment_instance, ihs, recommendation, action_item, team, roster_entry, duplicate_review, reporting_period to app_rw;
grant insert on roster_entry, access_grant to app_rw;
grant insert on audit_event, action_item to app_rw;
grant select (user_id, email, display_name, status, mfa_enrolled) on app_user to app_rw;
-- user_session, signup_token, email_outbox and password hashes are never reachable by app_rw.

-- ---- Policies ----
alter table tenant enable row level security;
create policy tenant_read on tenant for select using (
  exists (select 1 from role_assignment ra where ra.user_id = app_uid() and ra.tenant_id = tenant.tenant_id));

alter table program_year enable row level security;
create policy py_read on program_year for select using (app_has_role(tenant_id, array['program_admin', 'inst_leader', 'coach', 'health_support', 'athlete']));

alter table reporting_period enable row level security;
create policy rp_read on reporting_period for select using (app_has_role(tenant_id, array['program_admin', 'inst_leader', 'coach', 'health_support']));
create policy rp_admin on reporting_period for update using (app_is_admin(tenant_id));

alter table role_assignment enable row level security;
create policy ra_read on role_assignment for select using (user_id = app_uid() or app_is_admin(tenant_id));

alter table access_grant enable row level security;
create policy ag_read on access_grant for select using (user_id = app_uid() or app_is_admin(tenant_id));
create policy ag_insert on access_grant for insert with check (app_is_admin(tenant_id) and approved_by = app_uid());

alter table participant enable row level security;
create policy participant_read on participant for select using (user_id = app_uid() or app_staff_can_see(participant_id));

alter table athlete_profile enable row level security;
create policy profile_read on athlete_profile for select using (app_is_self(participant_id) or app_staff_can_see(participant_id));

alter table athletic_program enable row level security;
create policy program_read on athletic_program for select using (app_has_role(tenant_id, array['program_admin', 'inst_leader', 'coach', 'health_support']));

alter table team enable row level security;
create policy team_read on team for select using (
  app_has_role(tenant_id, array['program_admin', 'inst_leader', 'health_support'])
  or exists (select 1 from role_assignment ra where ra.user_id = app_uid() and ra.role = 'coach' and ra.scope_type = 'team' and ra.scope_id = team.team_id)
  or exists (select 1 from athlete_team_affiliation a join participant p on p.participant_id = a.participant_id
             where a.team_id = team.team_id and p.user_id = app_uid()));
create policy team_admin on team for update using (app_is_admin(tenant_id));

alter table athlete_team_affiliation enable row level security;
create policy aff_read on athlete_team_affiliation for select using (app_is_self(participant_id) or app_staff_can_see(participant_id));

alter table roster_entry enable row level security;
create policy roster_admin_read on roster_entry for select using (app_is_admin(tenant_id));
create policy roster_admin_insert on roster_entry for insert with check (app_is_admin(tenant_id));
create policy roster_admin_update on roster_entry for update using (app_is_admin(tenant_id));

alter table duplicate_review enable row level security;
create policy dup_admin on duplicate_review for select using (app_is_admin(tenant_id));
create policy dup_admin_upd on duplicate_review for update using (app_is_admin(tenant_id));

alter table assessment_instance enable row level security;
create policy inst_read on assessment_instance for select using (app_is_self(participant_id) or app_staff_can_see(participant_id));
create policy inst_self_update on assessment_instance for update
  using (app_is_self(participant_id) and status in ('Not Started', 'In Progress'))
  with check (status in ('Not Started', 'In Progress'));
create policy inst_admin_update on assessment_instance for update using (app_is_admin(tenant_id));

-- Responses: the athlete may write only while the instance is an editable draft (submission lock, TST-LFC-001).
alter table item_response enable row level security;
create policy resp_read on item_response for select using (
  app_is_self((select participant_id from assessment_instance i where i.instance_id = item_response.instance_id))
  or app_instance_staff(instance_id));
create policy resp_self_insert on item_response for insert with check (app_instance_editable_by_self(instance_id) and points is null);
create policy resp_self_update on item_response for update
  using (app_instance_editable_by_self(instance_id)) with check (app_instance_editable_by_self(instance_id) and points is null);

-- Results: staff in scope, or the athlete once released.
alter table validation_result enable row level security;
create policy val_read on validation_result for select using (
  app_instance_staff(instance_id)
  or app_is_self((select participant_id from assessment_instance i where i.instance_id = validation_result.instance_id)));

alter table category_score enable row level security;
create policy cat_read on category_score for select using (app_instance_staff(instance_id) or app_instance_released_to_self(instance_id));

alter table hgi_result enable row level security;
create policy hgi_read on hgi_result for select using (app_instance_staff(instance_id) or app_instance_released_to_self(instance_id));

alter table hga_finding enable row level security;
create policy hga_read on hga_finding for select using (app_instance_staff(instance_id) or app_instance_released_to_self(instance_id));

alter table hga_run enable row level security;
create policy hga_run_read on hga_run for select using (app_instance_staff(instance_id));

-- IHS approval is a WeCanH2O Program Administrator action; Technical Admin, Coach and Leadership cannot approve.
alter table ihs enable row level security;
create policy ihs_read on ihs for select using (
  app_staff_can_see(participant_id)
  or (app_is_self(participant_id) and status in ('Assigned / Delivered', 'Completed / Implemented', 'Reassessed')));
create policy ihs_admin on ihs for update using (app_is_admin(tenant_id));

alter table recommendation enable row level security;
create policy rec_read on recommendation for select using (
  app_instance_staff(instance_id)
  or (app_is_self((select participant_id from assessment_instance i where i.instance_id = recommendation.instance_id))
      and status in ('Assigned / Delivered', 'Completed / Implemented', 'Reassessed')));
create policy rec_admin on recommendation for update using (app_is_admin(tenant_id));

alter table action_item enable row level security;
create policy ai_read on action_item for select using (app_is_self(participant_id) or app_staff_can_see(participant_id));
create policy ai_self_update on action_item for update using (app_is_self(participant_id));
create policy ai_admin_insert on action_item for insert with check (app_is_admin(tenant_id));

alter table audit_event enable row level security;
create policy audit_insert on audit_event for insert with check (user_id = app_uid());
create policy audit_read on audit_event for select using (tenant_id is not null and app_is_admin(tenant_id));

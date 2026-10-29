-- 008 Milestone 5: reassessment workflow, longitudinal change analysis, history, administration.
-- Document #4 (REA / CHG), Milestone 3 Section 5, Document #7 (LFC-025..032), Document #6 (ROL-003/014).

-- ---- Reassessment target windows (REA-007..010). Stored separately from reporting periods. ----
create table reassessment_schedule (
  schedule_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  program_year_id uuid not null references program_year(program_year_id),
  target_start date not null,
  target_end date not null check (target_end >= target_start),
  outcome text not null default 'Scheduled'
    check (outcome in ('Scheduled', 'Completed', 'Reassessment Not Completed / Outcome Unknown', 'Cancelled')),
  actual_instance_id uuid references assessment_instance(instance_id),
  created_by uuid references app_user(user_id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index reassessment_one_open on reassessment_schedule (participant_id) where outcome = 'Scheduled';

alter table assessment_instance add column schedule_id uuid references reassessment_schedule(schedule_id);

-- ---- Version mapping (CHG-001..003): only WeCanH2O-approved mappings make different versions comparable. ----
create table rule_version_mapping (
  from_version_id text not null references rule_version(rule_version_id),
  to_version_id text not null references rule_version(rule_version_id),
  approved_by text not null,
  approved_at timestamptz not null default now(),
  primary key (from_version_id, to_version_id)
);

-- ---- Change analysis: baseline vs current (CHG-004..016). Superseded, never overwritten. ----
create table change_analysis (
  change_analysis_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  baseline_instance_id uuid not null references assessment_instance(instance_id),
  current_instance_id uuid not null references assessment_instance(instance_id),
  comparison_status text not null check (comparison_status in ('Comparable', 'Cross-Version Comparison - Review Required')),
  hgi_baseline numeric,
  hgi_current numeric,
  hgi_change numeric, -- current internal - baseline internal (CHG-005); null when not comparable
  category_changes jsonb not null default '[]',
  item_changes jsonb not null default '[]',
  contextual_changes jsonb not null default '[]', -- C7 tracked outside HGI (CHG-015)
  created_at timestamptz not null default now(),
  superseded_at timestamptz
);
create unique index change_analysis_current on change_analysis (current_instance_id) where superseded_at is null;

create table finding_change (
  finding_change_id uuid primary key default gen_random_uuid(),
  change_analysis_id uuid not null references change_analysis(change_analysis_id),
  tenant_id uuid not null references tenant(tenant_id),
  rule_id text not null,
  title text not null,
  state text not null check (state in ('Improved', 'Resolved', 'Persistent', 'Worsened', 'New')),
  measure_label text,
  baseline_measure numeric,
  current_measure numeric,
  source_class text,
  priority_class int,
  is_safety boolean not null default false,
  is_contextual boolean not null default false
);

-- Access grants can be ended early; history is kept.
alter table access_grant add column revoked_at timestamptz;
alter table access_grant add column revoked_by uuid references app_user(user_id);
alter table access_grant add column created_at timestamptz not null default now();

-- Grants now honour early revocation.
create or replace function app_has_grant(pid uuid) returns boolean language sql stable security definer as $$
  select exists (
    select 1 from access_grant g
    where g.user_id = app_uid() and g.participant_id = pid and g.valid_from <= now() and g.valid_to > now() and g.revoked_at is null)
$$;

-- ---- Grants and policies ----
grant select on reassessment_schedule, rule_version_mapping, change_analysis, finding_change to app_rw;

alter table reassessment_schedule enable row level security;
create policy rs_read on reassessment_schedule for select using (app_is_self(participant_id) or app_staff_can_see(participant_id));

alter table change_analysis enable row level security;
create policy ca_read on change_analysis for select using (
  app_staff_can_see(participant_id) or app_instance_released_to_self(current_instance_id));

alter table finding_change enable row level security;
create policy fc_read on finding_change for select using (exists (
  select 1 from change_analysis ca where ca.change_analysis_id = finding_change.change_analysis_id
    and (app_staff_can_see(ca.participant_id) or app_instance_released_to_self(ca.current_instance_id))));

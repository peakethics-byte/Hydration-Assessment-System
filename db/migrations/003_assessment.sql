-- 003 Assessment and results (Milestone 2 Section 2.5). Content is set by the population's rule versions.

create table assessment_item (
  item_id uuid primary key default gen_random_uuid(),
  asm_version_id text not null references rule_version(rule_version_id),
  item_code text not null,
  construct text not null,
  part int not null,
  category text not null,
  item_type text not null,
  is_scored boolean not null,
  required boolean not null,
  na_allowed boolean not null,
  optional boolean not null,
  multi_select boolean not null,
  prompt text not null,
  options jsonb not null, -- includes hidden point values; never sent to the athlete's browser
  display_order int not null,
  unique (asm_version_id, item_code)
);

create table assessment_instance (
  instance_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  program_year_id uuid not null references program_year(program_year_id),
  team_id uuid references team(team_id), -- affiliation snapshot at the assessment date
  asm_version_id text not null references rule_version(rule_version_id),
  scr_version_id text not null references rule_version(rule_version_id),
  hga_version_id text not null references rule_version(rule_version_id),
  rec_version_id text not null references rule_version(rule_version_id),
  status text not null default 'Not Started' check (status in (
    'Not Started', 'In Progress', 'Submitted', 'Validation Check', 'Complete / Scored',
    'Reviewed', 'Released', 'Correction Required', 'Revalidated', 'Expired')),
  is_baseline boolean not null default false,
  started_at timestamptz,
  last_saved_at timestamptz,
  draft_expires_at timestamptz, -- 14-day draft window
  submitted_at timestamptz,
  validated_at timestamptz,
  locked_at timestamptz,
  reviewed_at timestamptz,
  released_at timestamptz
);

-- One answer per item. Blank, value, approved N/A and Prefer not to answer are distinct states.
create table item_response (
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  item_code text not null,
  response_state text not null check (response_state in ('blank', 'value', 'na', 'prefer_not')),
  option_code text,
  option_codes text[],
  points numeric, -- filled by the scoring engine, never by the browser
  updated_at timestamptz not null default now(),
  primary key (instance_id, item_code)
);

create table validation_result (
  validation_id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  outcome text not null check (outcome in ('Passed', 'Assessment Incomplete - HGI Not Calculated', 'Insufficient Category 4 Data')),
  missing_items text[] not null default '{}',
  invalid_items text[] not null default '{}',
  c4_applicable_count int not null,
  checked_at timestamptz not null default now()
);

create table category_score (
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  category text not null,
  raw_score numeric,
  applicable_max numeric,
  applicable_count int,
  score_internal numeric, -- full precision
  score_display numeric(5, 1),
  percent_internal numeric,
  status text not null,
  scr_version_id text not null references rule_version(rule_version_id),
  primary key (instance_id, category)
);

create table hgi_result (
  instance_id uuid primary key references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  hgi_internal numeric,
  hgi_display numeric(5, 1),
  band text,
  status text not null check (status in ('Calculated', 'Incomplete', 'Insufficient Data')),
  scr_version_id text not null references rule_version(rule_version_id),
  calculated_at timestamptz not null default now()
);

create table hga_finding (
  finding_id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  rule_id text not null,
  rule_version_id text not null references rule_version(rule_version_id),
  finding_type text not null check (finding_type in ('cross', 'category', 'item', 'strength')),
  title text not null,
  category text,
  source_class text,
  priority_class int,
  rank int,
  is_safety boolean not null default false,
  input_refs jsonb not null default '{}'
);

-- Per-run HGA notes ("Not evaluable") and the Hydration Profile (reviewer-facing).
create table hga_run (
  instance_id uuid primary key references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  hga_version_id text not null references rule_version(rule_version_id),
  notes jsonb not null default '[]',
  hydration_profile jsonb not null,
  ran_at timestamptz not null default now()
);

create table rec_library_entry (
  entry_id text primary key,
  rec_version_id text not null references rule_version(rule_version_id),
  finding_rule_id text not null,
  pathway char(1) not null check (pathway in ('A', 'B', 'C', 'D', 'E', 'F')),
  athlete_text text not null,
  staff_text text not null,
  institution_text text not null,
  safety_restrictions text not null default '',
  is_placeholder boolean not null default true
);

-- Individualized Hydration Strategy. A later IHS supersedes an earlier one; it never overwrites it.
create table ihs (
  ihs_id uuid primary key default gen_random_uuid(),
  instance_id uuid not null unique references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  status text not null default 'Suggested by Rules Engine' check (status in (
    'Suggested by Rules Engine', 'Reviewed', 'Approved', 'Assigned / Delivered', 'Completed / Implemented', 'Reassessed')),
  supersedes_id uuid references ihs(ihs_id),
  reviewed_by uuid references app_user(user_id),
  reviewed_at timestamptz,
  approved_by uuid references app_user(user_id),
  approved_at timestamptz,
  released_at timestamptz
);

create table recommendation (
  rec_id uuid primary key default gen_random_uuid(),
  ihs_id uuid not null references ihs(ihs_id),
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  finding_id uuid not null references hga_finding(finding_id),
  entry_id text not null references rec_library_entry(entry_id),
  pathway char(1) not null check (pathway in ('A', 'B', 'C', 'D', 'E')), -- F can never be stored
  also_available text[] not null default '{}',
  audience text not null check (audience in ('athlete', 'institution', 'health_support')),
  reassessment_target text not null,
  rank int not null,
  is_safety boolean not null default false,
  status text not null default 'Suggested by Rules Engine' check (status in (
    'Suggested by Rules Engine', 'Reviewed', 'Approved', 'Not Approved', 'Assigned / Delivered', 'Completed / Implemented', 'Reassessed')),
  reviewer_note text,
  rec_version_id text not null references rule_version(rule_version_id),
  reviewed_by uuid references app_user(user_id),
  reviewed_at timestamptz,
  approved_by uuid references app_user(user_id),
  approved_at timestamptz,
  released_at timestamptz,
  -- Release gate in the database: nothing reaches Approved or later without a recorded approver.
  check (status in ('Suggested by Rules Engine', 'Reviewed', 'Not Approved') or approved_by is not null),
  check (status not in ('Assigned / Delivered', 'Completed / Implemented', 'Reassessed') or released_at is not null)
);

-- Hydration Action Items released to the athlete. Completion is not improvement (IHS-016).
create table action_item (
  action_item_id uuid primary key default gen_random_uuid(),
  rec_id uuid not null unique references recommendation(rec_id),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  status text not null default 'Assigned / Delivered' check (status in ('Assigned / Delivered', 'Completed / Implemented')),
  assigned_at timestamptz not null default now(),
  completed_at timestamptz
);

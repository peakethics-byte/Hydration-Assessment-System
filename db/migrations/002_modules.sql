-- 002 Module A (College Athletes, full MVP) and Module B (Corporate / Occupational, schema only).

create table participant (
  participant_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  population_code char(1) not null references population_module(code),
  athlete_code text not null unique, -- system-generated Athlete ID, the permanent key
  user_id uuid unique references app_user(user_id),
  status text not null default 'Active' check (status in ('Active', 'Deactivated', 'Archived', 'Merged')),
  merged_into_id uuid references participant(participant_id),
  created_at timestamptz not null default now()
);
create sequence athlete_code_seq;

-- ---- Module A ----
create table athletic_program (
  program_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  name text not null,
  status text not null default 'Active'
);

create table team (
  team_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  program_id uuid not null references athletic_program(program_id),
  name text not null,
  sport text not null,
  -- Recorded by the institution / WeCanH2O; drives HGA-INST-PROC (TST-C3Q4-008).
  heat_safety_procedures text not null default 'unknown' check (heat_safety_procedures in ('exist', 'none', 'unknown')),
  status text not null default 'Active'
);

create table athlete_profile (
  participant_id uuid primary key references participant(participant_id),
  tenant_id uuid not null references tenant(tenant_id),
  first_name text not null,
  last_name text not null,
  email text not null,
  institution_athlete_id text,
  -- Reassessment identity matching (client decision Oct 16, 2026). See personal_data_field.
  date_of_birth date,
  mothers_maiden_name_hash text, -- HMAC-SHA256 of the normalized value; the plain value is never stored
  identity_match_hash text -- HMAC of normalized name + date of birth + mother's maiden name
);
create index athlete_profile_match_idx on athlete_profile (tenant_id, identity_match_hash);

create table athlete_team_affiliation (
  affiliation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  team_id uuid not null references team(team_id),
  effective_start date not null default current_date,
  effective_end date
);

-- Team list sent by the college. Both sign-up ways start from this list.
create table roster_entry (
  roster_entry_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  team_id uuid not null references team(team_id),
  first_name text not null,
  last_name text not null,
  email_normalized text not null,
  institution_athlete_id text,
  status text not null default 'Listed' check (status in ('Listed', 'Invited', 'Link Sent', 'Registered', 'Withdrawn')),
  participant_id uuid references participant(participant_id),
  uploaded_by uuid references app_user(user_id),
  uploaded_at timestamptz not null default now(),
  unique (team_id, email_normalized)
);

-- One-time registration links. kind: 'invitation' (Way 2) or 'website' (Way 1).
create table signup_token (
  token_hash text primary key,
  tenant_id uuid not null references tenant(tenant_id),
  roster_entry_id uuid not null references roster_entry(roster_entry_id),
  kind text not null check (kind in ('invitation', 'website')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- Potential duplicates are reviewed by a person; never merged automatically on name (TST-LFC-005).
create table duplicate_review (
  duplicate_review_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  candidate_participant_id uuid not null references participant(participant_id),
  reason text not null,
  status text not null default 'Open' check (status in ('Open', 'Confirmed Different', 'Linked')),
  resolved_by uuid references app_user(user_id),
  resolved_at timestamptz
);

-- ---- Module B (Corporate / Occupational): schema only, no screens. Never reuses college content. ----
create table org_site (
  site_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  name text not null,
  status text not null default 'Active'
);
create table work_unit (
  work_unit_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  site_id uuid references org_site(site_id),
  name text not null,
  status text not null default 'Active'
);
create table exposure_group (
  exposure_group_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  name text not null,
  description text
);
create table employee_profile (
  participant_id uuid primary key references participant(participant_id),
  tenant_id uuid not null references tenant(tenant_id),
  job_role text,
  employee_reference text
);
create table employee_group_affiliation (
  affiliation_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  work_unit_id uuid references work_unit(work_unit_id),
  exposure_group_id uuid references exposure_group(exposure_group_id),
  effective_start date not null,
  effective_end date
);

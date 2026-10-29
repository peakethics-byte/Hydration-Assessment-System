-- 001 Shared core (Milestone 2 Section 2.2). Population-neutral; serves Module A and Module B.

create table population_module (
  code char(1) primary key check (code in ('A', 'B', 'C')),
  name text not null,
  status text not null check (status in ('Active', 'Schema only', 'Reserved'))
);

create table tenant (
  tenant_id uuid primary key default gen_random_uuid(),
  population_code char(1) not null references population_module(code),
  display_name text not null,
  status text not null default 'Setup' check (status in ('Setup', 'Active', 'Paused', 'Completed', 'Renewed', 'Archived')),
  created_at timestamptz not null default now()
);

create table program_year (
  program_year_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  program_start_date date not null,
  program_end_date date not null,
  renewed_from_id uuid references program_year(program_year_id),
  status text not null default 'Active' check (status in ('Setup', 'Active', 'Completed', 'Archived'))
);

create table reporting_period (
  period_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  program_year_id uuid not null references program_year(program_year_id),
  period_type text not null check (period_type in ('Q1', 'Q2', 'Q3', 'Q4', 'Annual')),
  start_date date not null,
  end_date date not null,
  original_start date not null,
  original_end date not null,
  adjusted_by uuid,
  adjusted_reason text,
  unique (program_year_id, period_type)
);

create table app_user (
  user_id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  password_hash text,
  status text not null default 'Active' check (status in ('Active', 'Deactivated')),
  mfa_enrolled boolean not null default false,
  failed_logins int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create unique index app_user_email_uq on app_user (lower(email));

create table user_session (
  session_hash text primary key,
  user_id uuid not null references app_user(user_id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

-- Business roles with a scope. tenant_id is null only for the Technical System Administrator.
create table role_assignment (
  role_assignment_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_user(user_id),
  role text not null check (role in ('athlete', 'program_admin', 'health_support', 'coach', 'inst_leader', 'tech_admin')),
  tenant_id uuid references tenant(tenant_id),
  scope_type text not null check (scope_type in ('platform', 'tenant', 'program', 'team', 'athlete')),
  scope_id uuid,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  can_export boolean not null default false, -- export is separate from view (ROL rules)
  check ((role = 'tech_admin') = (scope_type = 'platform')),
  check (role = 'tech_admin' or tenant_id is not null)
);

-- Explicit, time-limited extra access (e.g. coach individual access). Logged.
create table access_grant (
  grant_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  user_id uuid not null references app_user(user_id),
  participant_id uuid,
  team_id uuid,
  approved_by uuid not null references app_user(user_id),
  valid_from timestamptz not null default now(),
  valid_to timestamptz not null,
  reason text not null
);

-- Versioned methodology per population and rule family. Only WeCanH2O approves and activates.
create table rule_version (
  rule_version_id text primary key,
  population_code char(1) not null references population_module(code),
  family text not null check (family in ('ASM', 'SCR', 'HGA', 'REC', 'RPT')),
  version_label text not null,
  status text not null check (status in ('Draft', 'Approved', 'Active', 'Retired')),
  is_fixture boolean not null default false, -- "Fixture - not methodology": cannot be activated in production
  content jsonb not null,
  effective_from date,
  approved_by text,
  approved_at timestamptz
);

-- Data minimization (Sept 20 rule): every personal field records its purpose and approval status.
create table personal_data_field (
  field_name text primary key,
  table_name text not null,
  purpose text not null,
  storage text not null,
  approval_status text not null check (approval_status in ('Approved', 'Pending WeCanH2O approval')),
  approved_by text,
  approved_at timestamptz
);

-- Acknowledgment capability; wording is supplied by WeCanH2O.
create table ack_document_version (
  document_version_id text primary key,
  text_ref text not null,
  effective_from date not null
);

-- Append-only history of governed actions.
create table audit_event (
  event_id bigint generated always as identity primary key,
  tenant_id uuid,
  user_id uuid,
  action text not null,
  record_type text not null,
  record_id text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  rule_version_id text,
  created_at timestamptz not null default clock_timestamp()
);

create function audit_event_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_event is append-only';
end $$;
create trigger audit_event_no_update before update or delete on audit_event
  for each row execute function audit_event_immutable();

-- Transactional email (local development: messages stay in this outbox and show in the Dev Mailbox).
create table email_outbox (
  email_id bigint generated always as identity primary key,
  to_email text not null,
  subject text not null,
  body text not null,
  link text,
  created_at timestamptz not null default now()
);

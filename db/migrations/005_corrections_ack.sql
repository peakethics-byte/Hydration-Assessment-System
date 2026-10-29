-- 005 Governed corrections + revalidation (R-09; D07 LFC-014..016, AUD-101), draft reminders/reopen
-- (M1 O-05), versioned acknowledgment capability (R-41; D06 PRV-025..027; D07 LFC-033..036).

-- ---- Corrections: superseded results are kept, never silently replaced (LFC-016, AUD-003) ----
alter table hga_finding add column superseded_at timestamptz;
alter table recommendation add column superseded_at timestamptz;
alter table action_item add column superseded_at timestamptz;
alter table ihs add column superseded_at timestamptz;
alter table ihs drop constraint ihs_instance_id_key;
create unique index ihs_current_uq on ihs (instance_id) where superseded_at is null;

alter table assessment_instance add column reminder_sent_at timestamptz;
alter table assessment_instance add column correction_count int not null default 0;

create table response_correction (
  correction_id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  item_code text not null,
  original_state text not null,
  original_option_code text,
  original_option_codes text[],
  corrected_state text not null,
  corrected_option_code text,
  corrected_option_codes text[],
  reason text not null check (length(trim(reason)) > 0),
  corrected_by uuid not null references app_user(user_id),
  corrected_at timestamptz not null default now()
);

-- Snapshot of the authoritative result before each correction (HGI, categories, findings, IHS).
create table result_revision (
  revision_id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references assessment_instance(instance_id),
  tenant_id uuid not null references tenant(tenant_id),
  revision_no int not null,
  status_before text not null,
  snapshot jsonb not null,
  correction_id uuid references response_correction(correction_id),
  created_at timestamptz not null default now(),
  unique (instance_id, revision_no)
);

create function no_update_delete() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger response_correction_immutable before update or delete on response_correction for each row execute function no_update_delete();
create trigger result_revision_immutable before update or delete on result_revision for each row execute function no_update_delete();

-- ---- Acknowledgment / consent capability (wording supplied by WeCanH2O, never by the developer) ----
alter table ack_document_version add column body text not null default '';

create table privacy_config (
  tenant_id uuid primary key references tenant(tenant_id),
  ack_required boolean not null default false, -- participation gating, configurable (LFC-036)
  ack_document_version_id text references ack_document_version(document_version_id),
  suppression_threshold int, -- set by WeCanH2O (reporting, Milestone 6)
  draft_days int not null default 14,
  reminder_days_before int not null default 3,
  updated_by uuid references app_user(user_id),
  updated_at timestamptz not null default now()
);

create table ack_record (
  ack_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  participant_id uuid not null references participant(participant_id),
  program_year_id uuid references program_year(program_year_id),
  document_version_id text not null references ack_document_version(document_version_id),
  status text not null default 'Acknowledged' check (status in ('Acknowledged')),
  acknowledged_at timestamptz not null default now(),
  unique (participant_id, document_version_id)
);
create trigger ack_record_immutable before update or delete on ack_record for each row execute function no_update_delete();

-- ---- Grants and policies ----
grant select on response_correction, result_revision, privacy_config, ack_record to app_rw;
grant insert on ack_record to app_rw;
grant update on privacy_config to app_rw;

alter table response_correction enable row level security;
create policy corr_read on response_correction for select using (app_is_admin(tenant_id));

alter table result_revision enable row level security;
create policy rev_read on result_revision for select using (app_is_admin(tenant_id));

alter table privacy_config enable row level security;
create policy pc_read on privacy_config for select using (
  app_has_role(tenant_id, array['program_admin', 'athlete', 'health_support', 'coach', 'inst_leader']));
create policy pc_admin on privacy_config for update using (app_is_admin(tenant_id));

alter table ack_record enable row level security;
create policy ack_read on ack_record for select using (app_is_self(participant_id) or app_is_admin(tenant_id));
create policy ack_self_insert on ack_record for insert with check (app_is_self(participant_id));

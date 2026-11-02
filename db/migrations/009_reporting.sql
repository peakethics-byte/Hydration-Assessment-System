-- 009 Aggregation, dashboards and formal reporting (contract Week 6; Document #5).
-- Reports are generated from stored system data (REP-001), keep their numerators/denominators (REP-020),
-- follow Draft -> Under Review -> Revision Required -> Approved -> Released -> Superseded (LFC-201),
-- and are never silently overwritten once released (REP-034/035).

-- ---- Reporting settings per institution: small-cell suppression threshold (PRV-202, DRAFT value) ----
create table report_setting (
  tenant_id uuid primary key references tenant(tenant_id),
  suppression_threshold int not null default 5 check (suppression_threshold between 1 and 100),
  threshold_status text not null default 'DRAFT - pending privacy/legal/institutional review',
  updated_by uuid references app_user(user_id),
  updated_at timestamptz not null default now()
);

-- ---- Reporting-date changes keep the original and revised values (DAT-007, AUD-201) ----
create table reporting_period_change (
  change_id uuid primary key default gen_random_uuid(),
  period_id uuid not null references reporting_period(period_id),
  tenant_id uuid not null references tenant(tenant_id),
  old_start date not null,
  old_end date not null,
  new_start date not null,
  new_end date not null,
  reason text not null check (length(trim(reason)) > 0),
  changed_by uuid not null references app_user(user_id),
  changed_at timestamptz not null default now()
);

-- ---- Formal quarterly / annual reports ----
create table formal_report (
  report_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  program_year_id uuid not null references program_year(program_year_id),
  period_id uuid not null references reporting_period(period_id),
  report_type text not null check (report_type in ('Quarterly Hydration Gap Report', 'Annual Hydration Intelligence Impact Report')),
  report_number text not null,
  version int not null default 1,
  status text not null default 'Draft'
    check (status in ('Draft', 'Under Review', 'Revision Required', 'Approved', 'Released', 'Superseded')),
  content jsonb not null,            -- the computed figures at generation time (snapshot)
  narrative jsonb not null default '{}', -- text written by the WeCanH2O reviewer
  rule_versions text[] not null default '{}',
  suppression_threshold int not null,
  generated_by uuid not null references app_user(user_id),
  generated_at timestamptz not null default now(),
  submitted_at timestamptz,
  review_note text,
  approved_by uuid references app_user(user_id),
  approved_at timestamptz,
  released_by uuid references app_user(user_id),
  released_at timestamptz,
  supersedes_id uuid references formal_report(report_id),
  superseded_at timestamptz,
  correction_reason text,
  unique (report_number, version)
);

-- Approved, released and superseded reports are locked: figures and text can never change again (REP-035).
create function formal_report_lock() returns trigger language plpgsql as $$
begin
  if old.status in ('Approved', 'Released', 'Superseded') then
    if new.content is distinct from old.content or new.narrative is distinct from old.narrative
       or new.rule_versions is distinct from old.rule_versions or new.generated_at is distinct from old.generated_at then
      raise exception 'Report % is locked (%); issue a correction instead', old.report_number, old.status;
    end if;
    if old.status = 'Superseded' and new.status <> 'Superseded' then
      raise exception 'A superseded report stays superseded';
    end if;
    if old.status = 'Released' and new.status not in ('Released', 'Superseded') then
      raise exception 'A released report can only be superseded by a correction';
    end if;
  end if;
  if new.status = 'Released' and new.approved_at is null then
    raise exception 'A report cannot be released before WeCanH2O approval'; -- REP-033 / TST-REP-012
  end if;
  return new;
end $$;
create trigger formal_report_lock before update on formal_report for each row execute function formal_report_lock();
create function formal_report_no_delete() returns trigger language plpgsql as $$
begin raise exception 'Formal reports are never deleted'; end $$;
create trigger formal_report_no_delete before delete on formal_report for each row execute function formal_report_no_delete();

-- ---- Access: only WeCanH2O administrators read these tables directly. Aggregated results reach coaches and
-- leaders through the reporting service, after their reporting scope is checked and suppression is applied.
grant select on report_setting, reporting_period_change, formal_report to app_rw;

alter table report_setting enable row level security;
create policy rset_read on report_setting for select using (app_has_role(tenant_id, array['program_admin', 'inst_leader', 'coach']));

alter table reporting_period_change enable row level security;
create policy rpc_read on reporting_period_change for select using (app_is_admin(tenant_id));

alter table formal_report enable row level security;
create policy fr_admin_read on formal_report for select using (app_is_admin(tenant_id));
create policy fr_leader_read on formal_report for select using (status = 'Released' and app_has_role(tenant_id, array['inst_leader']));

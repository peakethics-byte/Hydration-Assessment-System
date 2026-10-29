-- 007 Staff accounts managed by the WeCanH2O Program Administrator, and individual users
-- (people who are not on a college team list): request access -> WeCanH2O approves -> email link ->
-- the same registration page as athletes (password, date of birth, mother's maiden name).

-- An "Individual Users" tenant holds people with no college or team, kept separate from institutions.
alter table tenant add column tenant_kind text not null default 'institution' check (tenant_kind in ('institution', 'personal'));

-- A staff member added by an administrator sets their own password through a one-time link.
alter table app_user add column setup_pending boolean not null default false;
grant select (setup_pending) on app_user to app_rw;

create table account_setup_token (
  token_hash text primary key,
  user_id uuid not null references app_user(user_id),
  tenant_id uuid not null references tenant(tenant_id),
  created_by uuid not null references app_user(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table access_request (
  request_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenant(tenant_id),
  first_name text not null,
  last_name text not null,
  email_normalized text not null,
  status text not null default 'Pending' check (status in ('Pending', 'Approved', 'Declined', 'Registered')),
  requested_at timestamptz not null default now(),
  decided_by uuid references app_user(user_id),
  decided_at timestamptz,
  decision_note text,
  participant_id uuid references participant(participant_id)
);
create unique index access_request_open_uq on access_request (email_normalized) where status in ('Pending', 'Approved');

-- Registration links now come from a team list entry OR an approved individual request.
alter table signup_token alter column roster_entry_id drop not null;
alter table signup_token add column access_request_id uuid references access_request(request_id);
alter table signup_token drop constraint signup_token_kind_check;
alter table signup_token add constraint signup_token_kind_check check (kind in ('invitation', 'website', 'personal'));
alter table signup_token add constraint signup_token_source_check check ((roster_entry_id is null) <> (access_request_id is null));

grant select, update on access_request to app_rw;
alter table access_request enable row level security;
create policy ar_admin_read on access_request for select using (app_is_admin(tenant_id));
create policy ar_admin_update on access_request for update using (app_is_admin(tenant_id));
-- account_setup_token is never reachable by app_rw.

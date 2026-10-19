alter table host_canisters
  add column if not exists alias text;

update host_canisters
set alias = lower(canister_id)
where alias is null or btrim(alias) = '';

update host_canisters
set alias = lower(alias)
where alias is not null;

alter table host_canisters
  alter column alias set not null;

create unique index if not exists host_canisters_alias_lower_idx
  on host_canisters ((lower(alias)));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'host_canisters_alias_format_check'
  ) then
    alter table host_canisters
      add constraint host_canisters_alias_format_check
      check (alias ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
  end if;
end
$$;

alter table tenants
  add column if not exists domain_mode text;

update tenants
set domain_mode = 'legacy'
where domain_mode is null;

alter table tenants
  alter column domain_mode set default 'legacy',
  alter column domain_mode set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenants_domain_mode_check'
  ) then
    alter table tenants
      add constraint tenants_domain_mode_check
      check (domain_mode in ('legacy', 'canister_alias'));
  end if;
end
$$;

create table if not exists admin_allowlist_emails (
  email text primary key,
  created_at timestamptz not null default now()
);

update admin_allowlist_emails
set email = lower(email)
where email <> lower(email);

create unique index if not exists admin_allowlist_emails_email_lower_idx
  on admin_allowlist_emails ((lower(email)));

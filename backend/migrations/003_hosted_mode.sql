create table if not exists tenants (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  slug text not null unique,
  created_at timestamptz not null default now()
);
create unique index if not exists tenants_slug_idx on tenants (slug);

create table if not exists host_canisters (
  id uuid primary key,
  canister_id text not null unique,
  capacity bigint,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  constraint host_canisters_status_check check (
    status in ('active', 'draining', 'full')
  )
);
create unique index if not exists host_canisters_canister_id_idx
  on host_canisters (canister_id);

create table if not exists tenant_hosts (
  tenant_id uuid not null references tenants(id) on delete cascade,
  host_canister_id uuid not null references host_canisters(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (tenant_id),
  unique (tenant_id)
);
create index if not exists tenant_hosts_tenant_id_idx on tenant_hosts (tenant_id);

create table if not exists eject_requests (
  id uuid primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  status text not null default 'requested',
  target_principal text not null,
  created_at timestamptz not null default now(),
  constraint eject_requests_status_check check (
    status in ('requested', 'running', 'complete', 'failed')
  )
);
create index if not exists eject_requests_tenant_id_idx on eject_requests (tenant_id);

alter table projects
  add column if not exists tenant_id uuid references tenants(id) on delete set null,
  add column if not exists hosted_url text,
  add column if not exists hosted_at timestamptz;

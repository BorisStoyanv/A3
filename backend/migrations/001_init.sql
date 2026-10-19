create table if not exists migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists users_email_lower_idx on users ((lower(email)));

create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);

create table if not exists github_accounts (
  user_id uuid primary key references users(id) on delete cascade,
  github_id bigint not null,
  login text not null,
  name text,
  avatar_url text,
  access_token_enc bytea not null,
  access_token_iv bytea not null,
  access_token_tag bytea not null,
  scope text,
  updated_at timestamptz not null default now()
);

create table if not exists projects (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  repo_url text not null,
  branch text not null,
  settings jsonb not null default '{}'::jsonb,
  identity text,
  webhook_token text not null,
  github_owner text,
  github_repo text,
  github_full_name text,
  github_default_branch text,
  github_webhook_id bigint,
  github_webhook_secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_deployment_id uuid,
  last_deployment_status text,
  last_deployment_endpoint text,
  last_deployment_canister_id text,
  last_deployment_identity text
);
create index if not exists projects_user_idx on projects(user_id);
create unique index if not exists projects_repo_unique on projects(user_id, repo_url);

create table if not exists deployments (
  id uuid primary key,
  project_id uuid not null references projects(id) on delete cascade,
  status text not null,
  repo_url text not null,
  branch text not null,
  network text not null,
  identity text,
  build_config jsonb not null,
  source text,
  commit text,
  metadata jsonb,
  logs text[] not null default '{}',
  endpoint text,
  canister_id text,
  canister_name text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer
);
create index if not exists deployments_project_idx on deployments(project_id, created_at desc);

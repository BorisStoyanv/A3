create table if not exists project_env_vars (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  key text not null,
  value_ciphertext text not null,
  is_secret boolean not null default true,
  kms_key_name text not null,
  created_by uuid not null references users(id) on delete restrict,
  updated_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_env_vars_project_key_unique unique (project_id, key),
  constraint project_env_vars_key_format check (key ~ '^[A-Z_][A-Z0-9_]*$'),
  constraint project_env_vars_key_len check (char_length(key) <= 128),
  constraint project_env_vars_value_len check (char_length(value_ciphertext) <= 16384)
);

create index if not exists project_env_vars_project_updated_idx
  on project_env_vars (project_id, updated_at desc);

create index if not exists project_env_vars_project_created_idx
  on project_env_vars (project_id, created_at desc);

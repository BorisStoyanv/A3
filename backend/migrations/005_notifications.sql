create table if not exists notifications (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  project_id uuid references projects(id) on delete set null,
  deployment_id uuid references deployments(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on notifications (user_id, created_at desc);

create index if not exists notifications_user_read_created_idx
  on notifications (user_id, read_at, created_at desc);

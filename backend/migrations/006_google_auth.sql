alter table if exists users
  add column if not exists google_sub text unique,
  add column if not exists auth_provider text not null default 'local',
  add column if not exists email_verified_at timestamptz;

alter table users
  add column if not exists display_name text,
  add column if not exists onboarding_source text,
  add column if not exists onboarding_completed_at timestamptz;

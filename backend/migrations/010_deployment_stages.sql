alter table deployments
  add column if not exists stages jsonb not null default jsonb_build_object(
    'build', jsonb_build_object('status', 'pending'),
    'deploy', jsonb_build_object('status', 'pending')
  );

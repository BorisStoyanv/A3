create table if not exists rate_limit_buckets (
  key text not null,
  window_start timestamptz not null,
  window_seconds integer not null,
  count integer not null default 0,
  expires_at timestamptz not null,
  primary key (key, window_start, window_seconds)
);

create index if not exists rate_limit_buckets_expires_at_idx
  on rate_limit_buckets (expires_at);

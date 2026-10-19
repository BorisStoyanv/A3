alter table sessions
  add column if not exists is_admin boolean not null default false,
  add column if not exists admin_checked_at timestamptz;

update sessions
set admin_checked_at = coalesce(admin_checked_at, last_seen_at, created_at, now())
where admin_checked_at is null;

do $$
begin
  if to_regclass('public.admin_allowlist_emails') is not null then
    update sessions s
    set is_admin = true,
        admin_checked_at = now()
    from users u
    where s.user_id = u.id
      and exists (
        select 1
        from admin_allowlist_emails a
        where lower(a.email) = lower(u.email)
      );
  end if;
end
$$;

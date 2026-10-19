alter table sessions
  add column if not exists csrf_token_hash text;

alter table users
  add column if not exists username text;

do $$
declare
  row_record record;
  base_username text;
  candidate_username text;
  suffix integer;
begin
  for row_record in
    select
      id,
      coalesce(
        nullif(username, ''),
        nullif(display_name, ''),
        nullif(split_part(email, '@', 1), ''),
        'user-' || substr(id::text, 1, 8)
      ) as seed
    from users
    order by created_at asc, id asc
  loop
    base_username := nullif(
      regexp_replace(trim(row_record.seed), '\s+', ' ', 'g'),
      ''
    );
    if base_username is null then
      base_username := 'user-' || substr(row_record.id::text, 1, 8);
    end if;

    candidate_username := base_username;
    suffix := 2;

    while exists (
      select 1
      from users u
      where lower(u.username) = lower(candidate_username)
        and u.id <> row_record.id
    ) loop
      candidate_username := base_username || '-' || suffix::text;
      suffix := suffix + 1;
    end loop;

    update users
    set username = candidate_username
    where id = row_record.id;
  end loop;
end $$;

update users
set display_name = username
where username is not null
  and (display_name is null or trim(display_name) = '');

create unique index if not exists users_username_lower_unique_idx
  on users (lower(username))
  where username is not null;

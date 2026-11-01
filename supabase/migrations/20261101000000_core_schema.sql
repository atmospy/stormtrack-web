-- StormTrack Web: core user schema (CONTRACTS §4).
-- Security model: every table has RLS enabled with explicit owner-only policies for
-- authenticated users; the anon role has no privileges at all. Per-user row caps and
-- size/range constraints limit abuse of the (public, anon-key-reachable) API.

---------------------------------------------------------------------------------------
-- helpers
---------------------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

-- BEFORE INSERT cap: TG_ARGV[0] = max rows per user. Runs as the caller (SECURITY INVOKER)
-- and filters explicitly on user_id, so it is correct for RLS and service-role inserts alike.
-- A transaction-level advisory lock per (table, user) serialises concurrent inserts so the
-- cap cannot be raced past.
create or replace function public.enforce_row_cap()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cap   integer := tg_argv[0]::integer;
  n     bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(tg_table_name || ':' || new.user_id::text, 0));
  execute format('select count(*) from %I.%I where user_id = $1', tg_table_schema, tg_table_name)
    into n using new.user_id;
  if n >= cap then
    raise exception 'limit reached: at most % rows allowed in %', cap, tg_table_name
      using errcode = 'check_violation', hint = 'Delete an existing item first.';
  end if;
  return new;
end;
$$;

---------------------------------------------------------------------------------------
-- profiles
---------------------------------------------------------------------------------------

create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  home_lat     double precision,
  home_lon     double precision,
  units        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_display_name_len check (display_name is null or char_length(display_name) between 1 and 80),
  constraint profiles_avatar_url_len   check (avatar_url is null or (char_length(avatar_url) <= 2048 and avatar_url ~* '^https?://')),
  constraint profiles_home_lat_range   check (home_lat is null or home_lat between -90 and 90),
  constraint profiles_home_lon_range   check (home_lon is null or home_lon between -180 and 180),
  constraint profiles_home_pair        check ((home_lat is null) = (home_lon is null)),
  constraint profiles_units_object     check (jsonb_typeof(units) = 'object' and octet_length(units::text) <= 2048)
);
comment on table public.profiles is 'One row per auth user, created by trigger on signup. Owner-only via RLS.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create the profile on signup. SECURITY DEFINER because auth.users inserts run as
-- supabase_auth_admin; search_path is pinned to '' so nothing can be shadowed.
-- Values from OAuth metadata are untrusted: clamp them so a long name can never make
-- signup itself fail on a constraint.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  nm  text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '');
  av  text := coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture');
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(nm, 80),
    case when av ~* '^https?://' and char_length(av) <= 2048 then av end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

---------------------------------------------------------------------------------------
-- saved_places
---------------------------------------------------------------------------------------

create table public.saved_places (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null,
  lat        double precision not null,
  lon        double precision not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_places_name_len  check (char_length(btrim(name)) between 1 and 80),
  constraint saved_places_lat_range check (lat between -90 and 90),
  constraint saved_places_lon_range check (lon between -180 and 180)
);
create index saved_places_user_created_idx on public.saved_places (user_id, created_at desc);

create trigger saved_places_set_updated_at
  before update on public.saved_places
  for each row execute function public.set_updated_at();
create trigger saved_places_row_cap
  before insert on public.saved_places
  for each row execute function public.enforce_row_cap('100');

---------------------------------------------------------------------------------------
-- saved_views
---------------------------------------------------------------------------------------

create table public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null,
  state      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_views_name_len     check (char_length(btrim(name)) between 1 and 80),
  constraint saved_views_state_object check (jsonb_typeof(state) = 'object'),
  constraint saved_views_state_size   check (octet_length(state::text) <= 16384)
);
create index saved_views_user_created_idx on public.saved_views (user_id, created_at desc);

create trigger saved_views_set_updated_at
  before update on public.saved_views
  for each row execute function public.set_updated_at();
create trigger saved_views_row_cap
  before insert on public.saved_views
  for each row execute function public.enforce_row_cap('50');

---------------------------------------------------------------------------------------
-- storm_follows
---------------------------------------------------------------------------------------

create table public.storm_follows (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storm_id   text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, storm_id),
  -- ATCF ids (IO042026, AL092026) and IBTrACS SIDs (2026302N12088) both fit this.
  constraint storm_follows_id_format check (storm_id ~ '^[A-Za-z0-9._-]{1,40}$')
);
-- For the future alert fan-out job (service role): who follows storm X?
create index storm_follows_storm_idx on public.storm_follows (storm_id);

create trigger storm_follows_row_cap
  before insert on public.storm_follows
  for each row execute function public.enforce_row_cap('200');

---------------------------------------------------------------------------------------
-- privileges: anon gets nothing; authenticated gets DML (RLS narrows it to own rows)
---------------------------------------------------------------------------------------

revoke all on table public.profiles, public.saved_places, public.saved_views, public.storm_follows from anon, public;
grant select, insert, update, delete on table public.profiles, public.saved_places, public.saved_views, public.storm_follows to authenticated;
-- A user may not rewrite ownership/immutable columns.
revoke update on public.profiles from authenticated;
grant  update (display_name, avatar_url, home_lat, home_lon, units) on public.profiles to authenticated;
revoke update on public.saved_places from authenticated;
grant  update (name, lat, lon) on public.saved_places to authenticated;
revoke update on public.saved_views from authenticated;
grant  update (name, state) on public.saved_views to authenticated;
-- storm_follows rows are immutable: follow/unfollow only.
revoke update on public.storm_follows from authenticated;

---------------------------------------------------------------------------------------
-- RLS: explicit owner-only policies, one per command. (select auth.uid()) is wrapped so
-- Postgres evaluates it once per statement instead of once per row.
---------------------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.saved_places  enable row level security;
alter table public.saved_views   enable row level security;
alter table public.storm_follows enable row level security;
alter table public.profiles      force row level security;
alter table public.saved_places  force row level security;
alter table public.saved_views   force row level security;
alter table public.storm_follows force row level security;

-- profiles (key is id)
create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_delete_own on public.profiles for delete to authenticated using (id = (select auth.uid()));

-- saved_places
create policy saved_places_select_own on public.saved_places for select to authenticated using (user_id = (select auth.uid()));
create policy saved_places_insert_own on public.saved_places for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_places_update_own on public.saved_places for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_places_delete_own on public.saved_places for delete to authenticated using (user_id = (select auth.uid()));

-- saved_views
create policy saved_views_select_own on public.saved_views for select to authenticated using (user_id = (select auth.uid()));
create policy saved_views_insert_own on public.saved_views for insert to authenticated with check (user_id = (select auth.uid()));
create policy saved_views_update_own on public.saved_views for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_views_delete_own on public.saved_views for delete to authenticated using (user_id = (select auth.uid()));

-- storm_follows (no update policy: rows are immutable)
create policy storm_follows_select_own on public.storm_follows for select to authenticated using (user_id = (select auth.uid()));
create policy storm_follows_insert_own on public.storm_follows for insert to authenticated with check (user_id = (select auth.uid()));
create policy storm_follows_delete_own on public.storm_follows for delete to authenticated using (user_id = (select auth.uid()));

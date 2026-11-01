-- pgTAP: schema, RLS, triggers, caps, constraints.  Run: supabase test db
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

-- fixtures (as postgres): three users; the signup trigger must create profiles
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a@test.local', '{"full_name":"Alice","picture":"https://example.com/a.png"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b@test.local', jsonb_build_object('name', repeat('x', 200), 'avatar_url', 'javascript:alert(1)')),
  ('cccccccc-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'c@test.local', '{}');

-- RLS enabled and forced on every table
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.profiles'::regclass),      'RLS on: profiles');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.saved_places'::regclass),  'RLS on: saved_places');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.saved_views'::regclass),   'RLS on: saved_views');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.storm_follows'::regclass), 'RLS on: storm_follows');

-- explicit policies for each command
select is((select count(*)::int from pg_policies where schemaname='public' and tablename='profiles'),      4, 'profiles has 4 policies');
select is((select count(*)::int from pg_policies where schemaname='public' and tablename='saved_places'),  4, 'saved_places has 4 policies');
select is((select count(*)::int from pg_policies where schemaname='public' and tablename='saved_views'),   4, 'saved_views has 4 policies');
select is((select count(*)::int from pg_policies where schemaname='public' and tablename='storm_follows'), 3, 'storm_follows has 3 policies (immutable rows)');

-- profile trigger
select is((select count(*)::int from public.profiles where id in ('aaaaaaaa-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000003')), 3, 'signup trigger created a profile per user');
select results_eq($$select display_name, avatar_url from public.profiles where id='aaaaaaaa-0000-0000-0000-000000000001'$$, $$values ('Alice'::text, 'https://example.com/a.png'::text)$$, 'profile copies name + avatar from OAuth metadata');
select results_eq($$select char_length(display_name), avatar_url from public.profiles where id='bbbbbbbb-0000-0000-0000-000000000002'$$, $$values (80, null::text)$$, 'hostile metadata clamped (200-char name -> 80, javascript: avatar dropped)');
select ok((select 'search_path=""' = any(proconfig) from pg_proc where oid = 'public.handle_new_user()'::regprocedure), 'handle_new_user has search_path pinned');

-- trigger function not callable by API roles
select ok(not has_function_privilege('authenticated', 'public.handle_new_user()', 'execute'), 'authenticated cannot execute handle_new_user');
select ok(not has_function_privilege('anon', 'public.handle_new_user()', 'execute'), 'anon cannot execute handle_new_user');

-- Alice
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', true);

select lives_ok($$insert into public.saved_places (name, lat, lon) values ('Home', 20.3, 85.8)$$, 'owner inserts a place without sending user_id');
select lives_ok($$insert into public.saved_views (name, state) values ('v1', '{"zoom":4}')$$, 'owner inserts a view');
select lives_ok($$insert into public.storm_follows (storm_id) values ('IO042026')$$, 'owner follows a storm');
select is((select count(*)::int from public.profiles), 1, 'owner sees exactly their own profile');
select lives_ok($$update public.saved_places set name = 'Home2'$$, 'owner updates own place');
select ok((select updated_at > created_at from public.saved_places limit 1), 'updated_at advanced by trigger');
select lives_ok($$update public.profiles set display_name = 'Alice B', home_lat = 10, home_lon = 20$$, 'owner updates own profile');

-- Bob: cross-user
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', true);

select is((select count(*)::int from public.saved_places),  0, 'Bob cannot read Alice places');
select is((select count(*)::int from public.saved_views),   0, 'Bob cannot read Alice views');
select is((select count(*)::int from public.storm_follows), 0, 'Bob cannot read Alice follows');
select is((select count(*)::int from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 0, 'Bob cannot read Alice profile');
select throws_ok($$insert into public.saved_places (user_id, name, lat, lon) values ('aaaaaaaa-0000-0000-0000-000000000001','pwn',0,0)$$, '42501', null, 'Bob cannot insert a place as Alice (RLS with check)');
select throws_ok($$insert into public.storm_follows (user_id, storm_id) values ('aaaaaaaa-0000-0000-0000-000000000001','X1')$$, '42501', null, 'Bob cannot insert a follow as Alice');

with u as (update public.saved_places set name = 'hacked' where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1) select is((select count(*)::int from u), 0, 'Bob update of Alice place affects 0 rows');
with d as (delete from public.saved_views where user_id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1) select is((select count(*)::int from d), 0, 'Bob delete of Alice view affects 0 rows');
with u as (update public.profiles set display_name = 'hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning 1) select is((select count(*)::int from u), 0, 'Bob update of Alice profile affects 0 rows');
select throws_ok($$update public.saved_places set user_id = 'aaaaaaaa-0000-0000-0000-000000000001'$$, '42501', null, 'user_id column is not updatable (column grants)');

reset role;
select results_eq($$select name from public.saved_places where user_id='aaaaaaaa-0000-0000-0000-000000000001'$$, $$values ('Home2'::text)$$, 'Alice place intact after Bob attempts');

-- anon: no privileges at all
set local role anon;
select throws_ok($$select * from public.profiles$$,      '42501', null, 'anon cannot select profiles');
select throws_ok($$select * from public.saved_places$$,  '42501', null, 'anon cannot select saved_places');
select throws_ok($$select * from public.saved_views$$,   '42501', null, 'anon cannot select saved_views');
select throws_ok($$select * from public.storm_follows$$, '42501', null, 'anon cannot select storm_follows');
select throws_ok($$insert into public.saved_places (user_id, name, lat, lon) values ('aaaaaaaa-0000-0000-0000-000000000001','x',0,0)$$, '42501', null, 'anon cannot insert');
reset role;

-- constraints and caps (as Carol)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-000000000003","role":"authenticated"}', true);
select throws_ok($$insert into public.saved_places (name, lat, lon) values ('x', 91, 0)$$,   '23514', null, 'lat > 90 rejected');
select throws_ok($$insert into public.saved_places (name, lat, lon) values ('x', 0, -181)$$, '23514', null, 'lon < -180 rejected');
select throws_ok($$insert into public.saved_places (name, lat, lon) values ('   ', 0, 0)$$,  '23514', null, 'blank name rejected');
select throws_ok($$insert into public.saved_places (name, lat, lon) values (repeat('n',81), 0, 0)$$, '23514', null, 'over-long name rejected');
select throws_ok($$insert into public.saved_views (name, state) values ('v', '[1,2]')$$,     '23514', null, 'non-object view state rejected');
select throws_ok($$insert into public.saved_views (name, state) values ('v', jsonb_build_object('blob', repeat('z', 20000)))$$, '23514', null, 'oversize view state (>16 kB) rejected');
select throws_ok($$insert into public.storm_follows (storm_id) values ('bad id; drop')$$,    '23514', null, 'malformed storm_id rejected');
select throws_ok($$update public.profiles set home_lat = 5$$, '23514', null, 'home_lat without home_lon rejected');

select lives_ok($$insert into public.saved_places (name, lat, lon) select 'p'||g, 0, 0 from generate_series(1,100) g$$, '100 places allowed');
select throws_like($$insert into public.saved_places (name, lat, lon) values ('one-too-many', 0, 0)$$, 'limit reached%', 'place #101 rejected by cap');
select lives_ok($$insert into public.saved_views (name, state) select 'v'||g, '{}' from generate_series(1,50) g$$, '50 views allowed');
select throws_like($$insert into public.saved_views (name, state) values ('too-many', '{}')$$, 'limit reached%', 'view #51 rejected by cap');
select lives_ok($$insert into public.storm_follows (storm_id) select 'S'||g from generate_series(1,200) g$$, '200 follows allowed');
select throws_like($$insert into public.storm_follows (storm_id) values ('S201')$$, 'limit reached%', 'follow #201 rejected by cap');
reset role;

-- cascade on account deletion
delete from auth.users where id = 'cccccccc-0000-0000-0000-000000000003';
select is((select count(*)::int from public.saved_places where user_id = 'cccccccc-0000-0000-0000-000000000003')
        + (select count(*)::int from public.profiles where id = 'cccccccc-0000-0000-0000-000000000003'), 0, 'deleting the auth user cascades to all rows');

select * from finish();
rollback;

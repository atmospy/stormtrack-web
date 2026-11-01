-- Local-dev seed. NEVER applied to production (`supabase db push` does not run seeds).
-- Demo user: demo@stormtrack.local / demo-password-1  (local stack only)
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated', 'demo@stormtrack.local',
  extensions.crypt('demo-password-1', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{"full_name":"Demo User"}', now(), now(),
  '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  gen_random_uuid(), '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'email',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"demo@stormtrack.local","email_verified":true}',
  now(), now(), now()
) on conflict do nothing;

insert into public.saved_places (user_id, name, lat, lon) values
  ('11111111-1111-1111-1111-111111111111', 'Bhubaneswar', 20.2961, 85.8245),
  ('11111111-1111-1111-1111-111111111111', 'Chennai', 13.0827, 80.2707),
  ('11111111-1111-1111-1111-111111111111', 'Miami', 25.7617, -80.1918);

insert into public.saved_views (user_id, name, state) values
  ('11111111-1111-1111-1111-111111111111', 'Bay of Bengal wind',
   '{"center":[88,15],"zoom":4,"layers":["wind","storms"],"time":null}');

insert into public.storm_follows (user_id, storm_id) values
  ('11111111-1111-1111-1111-111111111111', 'IO042026');

-- Manual assertion script for the org → team → project hierarchy.
--
-- HOW TO RUN: paste into the Supabase SQL editor (or psql as a privileged
-- role) against a branch/local database that has ALL migrations applied.
-- Everything runs in one transaction and ROLLBACKs at the end — no data is
-- left behind. A failed ASSERT aborts with the message; reaching the final
-- NOTICE means every check passed.
--
-- The script seeds as the privileged role (RLS bypassed for setup), then
-- impersonates users via `set local role authenticated` + request.jwt.claims
-- to exercise project_role()/RLS exactly as PostgREST would.

begin;

-- Fixed ids so assertions read clearly.
-- U_OWNER owns the projects; U_MEMBER is viewer in T1, admin in T2 (both org O1).
do $$
declare
  u_owner  uuid := '00000000-0000-0000-0000-0000000000a1';
  u_member uuid := '00000000-0000-0000-0000-0000000000a2';
  o1 uuid := '00000000-0000-0000-0000-0000000000b1';
  o2 uuid := '00000000-0000-0000-0000-0000000000b2';
  t1 uuid := '00000000-0000-0000-0000-0000000000c1';
  t2 uuid := '00000000-0000-0000-0000-0000000000c2';
  t3 uuid := '00000000-0000-0000-0000-0000000000c3';
  p_multi  uuid := '00000000-0000-0000-0000-0000000000d1';
  p_single uuid := '00000000-0000-0000-0000-0000000000d2';
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (u_owner, 'assert-owner@test.local', '{}'::jsonb),
           (u_member, 'assert-member@test.local', '{}'::jsonb);

  insert into public.organizations (id, owner_id, name) values (o1, u_owner, 'Assert Org 1'), (o2, u_owner, 'Assert Org 2');
  insert into public.teams (id, org_id, name) values (t1, o1, 'T1'), (t2, o1, 'T2'), (t3, o2, 'T3');

  insert into public.org_members (org_id, user_id, role, email) values (o1, u_member, 'viewer', 'assert-member@test.local');
  insert into public.team_members (team_id, user_id, role, email)
    values (t1, u_member, 'viewer', 'assert-member@test.local'),
           (t2, u_member, 'admin',  'assert-member@test.local');

  insert into public.projects (id, owner_id, name) values (p_multi, u_owner, 'Multi-team project'), (p_single, u_owner, 'Single-team project');
  insert into public.project_teams (project_id, team_id) values (p_multi, t1), (p_multi, t2), (p_single, t1);
end $$;

-- ---------------------------------------------------------------------
-- (A1) Multi-team max-role: U_MEMBER is viewer via T1 but admin via T2, so
-- their effective role on the two-team project must be 'admin'.
-- (A2) Single-team unchanged: on the T1-only project they stay 'viewer'.
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","email":"assert-member@test.local"}', true);

do $$
begin
  assert public.project_role('00000000-0000-0000-0000-0000000000d1') = 'admin',
    format('A1 FAILED: expected admin from max(viewer@T1, admin@T2), got %s',
           public.project_role('00000000-0000-0000-0000-0000000000d1'));
  assert public.project_role('00000000-0000-0000-0000-0000000000d2') = 'viewer',
    format('A2 FAILED: expected viewer via T1 only, got %s',
           public.project_role('00000000-0000-0000-0000-0000000000d2'));
end $$;

reset role;

-- ---------------------------------------------------------------------
-- (A3) Cross-org trigger: linking the O1 project to an O2 team must raise
-- 22023 — even for a privileged writer (triggers fire regardless of RLS).
-- ---------------------------------------------------------------------
do $$
begin
  begin
    insert into public.project_teams (project_id, team_id)
      values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3');
    raise exception 'A3 FAILED: cross-org project_teams insert was allowed';
  exception
    when sqlstate '22023' then null; -- expected
  end;
end $$;

-- ---------------------------------------------------------------------
-- (A4) set_project_teams: as the project owner, replacing the set works and
-- a cross-org mix is rejected atomically (original links survive).
-- ---------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","email":"assert-owner@test.local"}', true);

do $$
begin
  perform public.set_project_teams('00000000-0000-0000-0000-0000000000d2',
    array['00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2']::uuid[]);
  assert (select count(*) from public.project_teams where project_id = '00000000-0000-0000-0000-0000000000d2') = 2,
    'A4 FAILED: replace-set did not produce 2 links';

  begin
    perform public.set_project_teams('00000000-0000-0000-0000-0000000000d2',
      array['00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c3']::uuid[]);
    raise exception 'A4 FAILED: cross-org set was allowed';
  exception
    when sqlstate '22023' then null; -- expected
  end;

  -- Atomicity: the failed replace must not have touched the existing links.
  assert (select count(*) from public.project_teams where project_id = '00000000-0000-0000-0000-0000000000d2') = 2,
    'A4 FAILED: failed replace-set left the project with a different link count';
end $$;

reset role;

do $$ begin raise notice 'ALL HIERARCHY ASSERTIONS PASSED'; end $$;

rollback;

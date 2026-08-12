-- Give every existing project a home in the new hierarchy. Access is already
-- preserved by project_role()'s direct-project branch; this only establishes
-- structure. One default org per distinct project owner, one default team in
-- it, and all of that owner's teamless projects pointed at it. The
-- `team_id is null` guard makes a re-run a no-op.
do $$
declare
  r record;
  v_org_id uuid;
  v_team_id uuid;
begin
  for r in select distinct owner_id from public.projects where team_id is null loop
    insert into public.organizations (owner_id, name)
      values (r.owner_id, 'Default Organization') returning id into v_org_id;
    insert into public.teams (org_id, name)
      values (v_org_id, 'Default Team') returning id into v_team_id;
    update public.projects set team_id = v_team_id
      where owner_id = r.owner_id and team_id is null;
  end loop;
end $$;

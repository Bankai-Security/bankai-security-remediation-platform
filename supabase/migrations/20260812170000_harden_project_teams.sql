-- Data-integrity hardening for project ↔ team assignment.
--
-- 1) set_project_teams(): the API previously replaced a project's team set as
--    two separate PostgREST calls (DELETE then INSERT) — if the insert failed,
--    the project was left with no teams. A plpgsql function body is a single
--    transaction, so the replace is now atomic. Deliberately NOT security
--    definer: the existing project_teams RLS policies still gate every row the
--    function touches, so this adds atomicity without widening authority.
--
-- 2) enforce_project_single_org(): the "all of a project's teams share one
--    org" invariant was app-enforced only. A BEFORE INSERT trigger closes it at
--    the DB layer for every write path (API, RPC, SQL editor alike).

-- ---------------------------------------------------------------------
-- set_project_teams: atomically replace the full team set of a project.
-- Raises:
--   42501 — caller is not the project's owner/admin
--   22023 — a team id is unknown/not visible to the caller, or the ids span
--           more than one organization
-- ---------------------------------------------------------------------
create or replace function public.set_project_teams(p_project_id uuid, p_team_ids uuid[])
returns uuid[]
language plpgsql
set search_path = public
as $$
declare
  v_ids uuid[];
  v_visible integer;
  v_orgs integer;
begin
  if public.project_role(p_project_id) not in ('owner', 'admin') then
    raise exception 'Admin access required to change a project''s teams'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct id), '{}') into v_ids
    from unnest(p_team_ids) as t(id);

  if array_length(v_ids, 1) is not null then
    -- Not security definer, so this SELECT runs under the teams RLS policy:
    -- a team in an org the caller doesn't belong to simply doesn't come back,
    -- which makes "invisible" and "nonexistent" indistinguishable — exactly
    -- the non-leaky behavior we want.
    select count(*), count(distinct org_id) into v_visible, v_orgs
      from public.teams where id = any(v_ids);

    if v_visible <> array_length(v_ids, 1) then
      raise exception 'One or more teams don''t exist or you don''t have access to them.'
        using errcode = '22023';
    end if;
    if v_orgs > 1 then
      raise exception 'All of a project''s teams must be in the same organization.'
        using errcode = '22023';
    end if;
  end if;

  delete from public.project_teams where project_id = p_project_id;

  if array_length(v_ids, 1) is not null then
    insert into public.project_teams (project_id, team_id)
      select p_project_id, id from unnest(v_ids) as t(id);
  end if;

  return v_ids;
end;
$$;

-- ---------------------------------------------------------------------
-- enforce_project_single_org: DB-level guard for the one-org invariant.
-- SECURITY DEFINER because the check must see ALL of the project's existing
-- links and their teams' orgs — the inserting caller's RLS view of teams may
-- be narrower than the project's full membership (e.g. a project owner who
-- isn't in one of its orgs), and an integrity check must not depend on who
-- happens to be writing.
-- ---------------------------------------------------------------------
create or replace function public.enforce_project_single_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_org uuid;
begin
  select org_id into v_new_org from public.teams where id = new.team_id;

  if exists (
    select 1
      from public.project_teams pt
      join public.teams t on t.id = pt.team_id
      where pt.project_id = new.project_id
        and t.org_id <> v_new_org
  ) then
    raise exception 'All of a project''s teams must be in the same organization.'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

drop trigger if exists project_teams_single_org on public.project_teams;

create trigger project_teams_single_org
  before insert on public.project_teams
  for each row execute function public.enforce_project_single_org();

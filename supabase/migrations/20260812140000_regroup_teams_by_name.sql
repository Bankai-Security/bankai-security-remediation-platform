-- Corrective backfill for the Org → Team → Project hierarchy.
--
-- The first backfill (20260812120100) put every existing project under a single
-- catch-all team literally named 'Default Team' per org, ignoring the legacy
-- free-text `projects.team_name` label users had already typed. This regroups
-- projects into real teams derived from that label so the org rollup shows the
-- team names users actually specified (e.g. "Test Team") instead of one lump.
--
-- Grouping key is (org, team_name): projects that share an org AND the same
-- team_name land in ONE team. The org is read from each project's CURRENT team
-- (team_id -> teams.org_id), so this stays correct even if an owner later ends
-- up with more than one org. Projects whose team_name is null/blank keep their
-- existing 'Default Team' home.
--
-- Idempotent: find-or-create means a second run just re-points each project at
-- the same team it already has; the empty-team cleanup at the end has nothing
-- left to remove.
--
-- NOTE: this only touches projects already attached to a team. Projects with a
-- null team_id (not in the hierarchy at all) are out of scope here — that's a
-- separate gap in project creation, not a naming/grouping problem.

do $$
declare
  p record;
  v_org_id uuid;
  v_team_id uuid;
  v_team_name text;
begin
  for p in
    select pr.id, btrim(pr.team_name) as team_name, t.org_id
    from public.projects pr
    join public.teams t on t.id = pr.team_id
    where pr.team_name is not null and btrim(pr.team_name) <> ''
  loop
    v_org_id := p.org_id;
    v_team_name := p.team_name;

    -- Find the team named after this project's team_name within its org, or
    -- create it. Sequential loop, so no concurrent-insert race to guard.
    select id into v_team_id
      from public.teams
      where org_id = v_org_id and name = v_team_name
      limit 1;

    if v_team_id is null then
      insert into public.teams (org_id, name)
        values (v_org_id, v_team_name)
        returning id into v_team_id;
    end if;

    update public.projects set team_id = v_team_id where id = p.id;
  end loop;

  -- Drop 'Default Team' rows left empty by the regroup so the rollup doesn't
  -- render an empty section. Scoped to that exact name and only when no project
  -- references the team — safe today, since teams are created solely by the
  -- backfills (users have no team-management API yet), and any 'Default Team'
  -- that still holds null-team_name projects is retained because it isn't empty.
  -- Alias the subquery table 'pj', not 'p': 'p' is the loop record variable
  -- above and would shadow the table here (it has no team_id field).
  delete from public.teams t
    where t.name = 'Default Team'
      and not exists (select 1 from public.projects pj where pj.team_id = t.id);
end $$;

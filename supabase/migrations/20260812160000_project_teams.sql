-- Move project ↔ team from one-to-one (projects.team_id) to many-to-many, so a
-- project can belong to several teams. A project still belongs to a single org
-- — the app enforces that every team a project joins shares one org — so the
-- org rollup and the org-filtered Projects page stay coherent.

-- Join table ----------------------------------------------------------
create table if not exists public.project_teams (
  project_id uuid not null references public.projects (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, team_id)
);

create index if not exists project_teams_project_id_idx on public.project_teams (project_id);
create index if not exists project_teams_team_id_idx on public.project_teams (team_id);

-- Backfill from the scalar column before it's dropped: every project currently
-- in a team gets one link row.
--
-- Guarded because the last statement of this migration drops projects.team_id:
-- without the check, re-running the file fails here with "column team_id does
-- not exist". Inside a DO block the INSERT is only parsed if the branch is
-- taken, so it's a clean no-op once the column is gone.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'projects' and column_name = 'team_id'
  ) then
    insert into public.project_teams (project_id, team_id)
      select id, team_id from public.projects where team_id is not null
    on conflict do nothing;
  end if;
end $$;

-- RLS: mirrors team_members — visible if you can see the project or the team;
-- only project owners/admins can attach or detach teams. project_role() is
-- SECURITY DEFINER, so its own read of project_teams below doesn't recurse
-- through this policy.
alter table public.project_teams enable row level security;

-- Dropped first so the file can be re-run (CREATE POLICY has no IF NOT EXISTS).
drop policy if exists "Members can view a project's team links" on public.project_teams;
create policy "Members can view a project's team links"
  on public.project_teams for select
  using (public.project_role(project_id) is not null or public.team_role(team_id) is not null);

drop policy if exists "Project owners and admins can attach teams" on public.project_teams;
create policy "Project owners and admins can attach teams"
  on public.project_teams for insert
  with check (public.project_role(project_id) in ('owner', 'admin'));

drop policy if exists "Project owners and admins can detach teams" on public.project_teams;
create policy "Project owners and admins can detach teams"
  on public.project_teams for delete
  using (public.project_role(project_id) in ('owner', 'admin'));

-- project_role(): same signature/return, same max-role semantics. The only
-- change from 20260812120000 is that the team and team's-org candidate branches
-- now fan out over ALL of the project's teams via project_teams instead of the
-- single projects.team_id. The `case max(rank)` already aggregates multiple
-- candidate rows, so a project in one team resolves exactly as before.
create or replace function public.project_role(p_project_id uuid)
returns text language sql stable security definer set search_path = public
as $$
  with candidate(rank) as (
    -- direct project ownership -> 'owner'
    select 4 where exists (
      select 1 from public.projects p
      where p.id = p_project_id and p.owner_id = auth.uid()
    )
    union all
    -- direct project membership
    select case m.role when 'admin' then 3 when 'editor' then 2 else 1 end
      from public.project_members m
      where m.project_id = p_project_id and m.user_id = auth.uid()
    union all
    -- any team the project belongs to
    select case tm.role when 'admin' then 3 when 'editor' then 2 else 1 end
      from public.project_teams pt
      join public.team_members tm on tm.team_id = pt.team_id
      where pt.project_id = p_project_id and tm.user_id = auth.uid()
    union all
    -- the org of any team the project belongs to (org owner folds to admin=3)
    select case
             when o.owner_id = auth.uid() then 3
             when om.role = 'admin' then 3
             when om.role = 'editor' then 2
             when om.role = 'viewer' then 1
           end
      from public.project_teams pt
      join public.teams t on t.id = pt.team_id
      join public.organizations o on o.id = t.org_id
      left join public.org_members om
        on om.org_id = o.id and om.user_id = auth.uid()
      where pt.project_id = p_project_id
        and (o.owner_id = auth.uid() or om.user_id is not null)
  )
  select case max(rank)
           when 4 then 'owner' when 3 then 'admin'
           when 2 then 'editor' when 1 then 'viewer'
         end
  from candidate;   -- empty candidate -> max is NULL -> returns NULL (no access)
$$;

-- Retire the scalar FK now that project_role() no longer reads it and the data
-- lives in project_teams. (The earlier team_id-writing migrations
-- 20260812120100 / 20260812140000 are superseded by this backfill.)
drop index if exists public.projects_team_id_idx;
alter table public.projects drop column if exists team_id;

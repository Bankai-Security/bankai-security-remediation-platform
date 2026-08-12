-- Org → Team → Project hierarchy: data layer only (tables, helpers, RLS).
-- No API/frontend. project_role() is rewritten to return the MAX role a user
-- holds via any of three paths (direct project grant / project's team /
-- team's org). The rewrite is monotonic — it only ever returns a role >= the
-- old value — so every existing policy inherits org/team access unchanged.
-- Membership roles are admin/editor/viewer everywhere; 'owner' is derived
-- only from an *_owner_id column, and org/team paths cap at 'admin'.

-- organizations -------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists organizations_owner_id_idx on public.organizations (owner_id);
drop trigger if exists set_organizations_updated_at on public.organizations;
create trigger set_organizations_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- teams ---------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists teams_org_id_idx on public.teams (org_id);
drop trigger if exists set_teams_updated_at on public.teams;
create trigger set_teams_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

-- org_members ---------------------------------------------------------
create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index if not exists org_members_org_id_idx on public.org_members (org_id);
create index if not exists org_members_user_id_idx on public.org_members (user_id);

-- team_members --------------------------------------------------------
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);
create index if not exists team_members_team_id_idx on public.team_members (team_id);
create index if not exists team_members_user_id_idx on public.team_members (user_id);

-- projects.team_id ----------------------------------------------------
-- Nullable: a project with no team simply gets no org/team-derived role, and
-- keeps working via the direct-project branch of project_role().
alter table public.projects
  add column if not exists team_id uuid references public.teams (id) on delete set null;
create index if not exists projects_team_id_idx on public.projects (team_id);

-- org_role(): SECURITY DEFINER, mirrors project_role() exactly (owner_id ->
-- 'owner', else org_members role). Definer breaks recursion with org_members'
-- own SELECT policy below.
create or replace function public.org_role(p_org_id uuid)
returns text language sql stable security definer set search_path = public
as $$
  select case
    when exists (
      select 1 from public.organizations o
      where o.id = p_org_id and o.owner_id = auth.uid()
    ) then 'owner'
    else (
      select m.role from public.org_members m
      where m.org_id = p_org_id and m.user_id = auth.uid()
    )
  end;
$$;

-- team_role(): a team has no owner of its own — org owners/admins inherit
-- 'admin' over every team in their org; everyone else gets their direct grant.
-- SECURITY DEFINER breaks recursion with team_members' SELECT policy.
create or replace function public.team_role(p_team_id uuid)
returns text language sql stable security definer set search_path = public
as $$
  select case
    when public.org_role((select org_id from public.teams where id = p_team_id))
         in ('owner', 'admin') then 'admin'
    else (
      select m.role from public.team_members m
      where m.team_id = p_team_id and m.user_id = auth.uid()
    )
  end;
$$;

-- project_role(): rewritten. Same signature and text return type. Effective
-- role = MAX over four candidate paths, ranked viewer<editor<admin<owner.
-- Only the direct-project-ownership path can yield 'owner'; team and org
-- paths cap at 'admin' (rank 3), so the '= owner' policies stay owner-only.
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
    -- the project's team
    select case tm.role when 'admin' then 3 when 'editor' then 2 else 1 end
      from public.projects p
      join public.team_members tm on tm.team_id = p.team_id
      where p.id = p_project_id and tm.user_id = auth.uid()
    union all
    -- the team's org (org owner folds to admin=3, not owner)
    select case
             when o.owner_id = auth.uid() then 3
             when om.role = 'admin' then 3
             when om.role = 'editor' then 2
             when om.role = 'viewer' then 1
           end
      from public.projects p
      join public.teams t on t.id = p.team_id
      join public.organizations o on o.id = t.org_id
      left join public.org_members om
        on om.org_id = o.id and om.user_id = auth.uid()
      where p.id = p_project_id
        and (o.owner_id = auth.uid() or om.user_id is not null)
  )
  select case max(rank)
           when 4 then 'owner' when 3 then 'admin'
           when 2 then 'editor' when 1 then 'viewer'
         end
  from candidate;   -- empty candidate -> max is NULL -> returns NULL (no access)
$$;

-- RLS: organizations --------------------------------------------------
alter table public.organizations enable row level security;
create policy "Org members can view their org"
  on public.organizations for select using (public.org_role(id) is not null);
create policy "Users can create organizations they own"
  on public.organizations for insert with check (owner_id = auth.uid());
create policy "Org owners and admins can update the org"
  on public.organizations for update using (public.org_role(id) in ('owner', 'admin'));
create policy "Org owners can delete the org"
  on public.organizations for delete using (owner_id = auth.uid());

-- RLS: teams ----------------------------------------------------------
alter table public.teams enable row level security;
create policy "Org and team members can view teams"
  on public.teams for select
  using (public.org_role(org_id) is not null or public.team_role(id) is not null);
create policy "Org owners and admins can create teams"
  on public.teams for insert with check (public.org_role(org_id) in ('owner', 'admin'));
create policy "Team and org admins can update teams"
  on public.teams for update using (public.team_role(id) = 'admin');
create policy "Org owners and admins can delete teams"
  on public.teams for delete using (public.org_role(org_id) in ('owner', 'admin'));

-- RLS: org_members ----------------------------------------------------
alter table public.org_members enable row level security;
create policy "Org members can view the org roster"
  on public.org_members for select using (public.org_role(org_id) is not null);
create policy "Org owners and admins can add members"
  on public.org_members for insert with check (public.org_role(org_id) in ('owner', 'admin'));
create policy "Org owners and admins can change member roles"
  on public.org_members for update using (public.org_role(org_id) in ('owner', 'admin'));
create policy "Org owners and admins can remove members"
  on public.org_members for delete using (public.org_role(org_id) in ('owner', 'admin'));

-- RLS: team_members ---------------------------------------------------
alter table public.team_members enable row level security;
create policy "Team members and org admins can view the team roster"
  on public.team_members for select using (public.team_role(team_id) is not null);
create policy "Team and org admins can add team members"
  on public.team_members for insert with check (public.team_role(team_id) = 'admin');
create policy "Team and org admins can change team member roles"
  on public.team_members for update using (public.team_role(team_id) = 'admin');
create policy "Team and org admins can remove team members"
  on public.team_members for delete using (public.team_role(team_id) = 'admin');

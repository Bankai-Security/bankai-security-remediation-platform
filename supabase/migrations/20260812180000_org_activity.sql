-- Append-only audit trail for organization-level changes (org renames, team
-- create/delete, membership and invite events). activity_events can't host
-- these — it's hard-scoped to projects (project_id NOT NULL and a
-- project-flavored event_type check), so orgs get their own table with the
-- same append-only shape.
--
-- Known caveat, accepted for now: deleting an org cascades its audit trail
-- away with it (same as every other child row). A tamper-proof log would need
-- an external sink.

create table if not exists public.org_activity_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  -- Which team the event concerns, when it concerns one. set null on team
  -- deletion so "team deleted" events outlive the team itself.
  team_id uuid references public.teams (id) on delete set null,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_label text not null,
  event_type text not null check (event_type in ('org', 'team', 'member', 'invite')),
  summary text not null,
  meta text,
  created_at timestamptz not null default now()
);

create index if not exists org_activity_events_org_id_idx
  on public.org_activity_events (org_id, created_at desc);

alter table public.org_activity_events enable row level security;

-- Any org member may read the org's trail; any org member may append (writes
-- happen through the user-scoped client from controllers — including invite
-- acceptance, where the accepter has just become a member). Append-only: no
-- UPDATE or DELETE policies, deliberately, mirroring activity_events.
create policy "Org members can view org activity"
  on public.org_activity_events for select
  using (public.org_role(org_id) is not null);

create policy "Org members can record org activity"
  on public.org_activity_events for insert
  with check (public.org_role(org_id) is not null);

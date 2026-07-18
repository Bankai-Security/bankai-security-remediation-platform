-- Project sharing/collaboration: three roles (admin/editor/viewer) on top
-- of the existing owner concept, backed by a single reusable
-- project_role() helper that every rewritten policy below calls instead of
-- repeating the owner_id exists-check. project_role() is SECURITY DEFINER
-- for a structural reason, not just style: its own lookup into
-- project_members would otherwise trigger project_members' own SELECT
-- policy (which itself calls project_role()), causing infinite recursion.
-- Being SECURITY DEFINER breaks that cycle. It's safe because it only ever
-- resolves auth.uid()'s own role — it can't be used to probe anyone else's.
--
-- Ordering matters in this file: tables must exist before project_role()
-- is defined (a `language sql` function is parse-analyzed against its
-- referenced relations at CREATE time, not just at call time), and
-- project_role() must exist before any policy that calls it.

-- ---------------------------------------------------------------------
-- project_members: accepted collaborators. email is a denormalized
-- snapshot captured at accept time (same pattern as
-- activity_events.actor_label) so listing members never needs a
-- service-role lookup per row — only the owner (who isn't a row in this
-- table) needs one, synthesized app-side.
-- ---------------------------------------------------------------------
create table if not exists public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  email text not null,
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index if not exists project_members_project_id_idx on public.project_members (project_id);
create index if not exists project_members_user_id_idx on public.project_members (user_id);

-- ---------------------------------------------------------------------
-- project_invites: pending/resolved invitations by email + a shareable
-- token. Manual link-sharing only — no email is ever sent by this app.
-- ---------------------------------------------------------------------
create table if not exists public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  token uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists project_invites_project_id_idx on public.project_invites (project_id);

-- Only one *pending* invite per (project, email) at a time — re-inviting
-- after a decline/revoke is fine since that row's status is no longer
-- 'pending' and won't collide with this partial index.
create unique index if not exists project_invites_pending_email_idx
  on public.project_invites (project_id, lower(email))
  where status = 'pending';

-- ---------------------------------------------------------------------
-- project_role(): now that both tables exist, define the shared helper.
-- ---------------------------------------------------------------------
create or replace function public.project_role(p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.projects p
      where p.id = p_project_id and p.owner_id = auth.uid()
    ) then 'owner'
    else (
      select m.role from public.project_members m
      where m.project_id = p_project_id and m.user_id = auth.uid()
    )
  end;
$$;

-- ---------------------------------------------------------------------
-- RLS on the two new tables (project_role() now exists to reference).
-- ---------------------------------------------------------------------
alter table public.project_members enable row level security;

create policy "Project members can view the member list"
  on public.project_members for select
  using (public.project_role(project_id) is not null);

-- Real inserts only ever happen inside accept_project_invite() below (a
-- SECURITY DEFINER function, so it bypasses this policy entirely — an
-- invitee has no project_role yet, so they could never pass this check
-- directly). This policy exists purely as defense-in-depth against any
-- future/direct insert path.
create policy "Owners and admins can add members"
  on public.project_members for insert
  with check (public.project_role(project_id) in ('owner', 'admin'));

create policy "Owners and admins can change member roles"
  on public.project_members for update
  using (public.project_role(project_id) in ('owner', 'admin'))
  with check (public.project_role(project_id) in ('owner', 'admin'));

create policy "Owners and admins can remove members"
  on public.project_members for delete
  using (public.project_role(project_id) in ('owner', 'admin'));

alter table public.project_invites enable row level security;

create policy "Owners and admins can view invites for their project"
  on public.project_invites for select
  using (public.project_role(project_id) in ('owner', 'admin'));

-- Matches the invitee's own JWT email claim — they aren't a project member
-- yet, so project_role() would return null for them; this is a separate,
-- non-membership-based auth condition.
create policy "Invited users can view their own pending invites"
  on public.project_invites for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "Owners and admins can create invites"
  on public.project_invites for insert
  with check (public.project_role(project_id) in ('owner', 'admin'));

create policy "Owners and admins can revoke invites"
  on public.project_invites for update
  using (public.project_role(project_id) in ('owner', 'admin'))
  with check (public.project_role(project_id) in ('owner', 'admin'));

-- Invitees may self-service ONLY a decline directly. Acceptance is
-- deliberately NOT reachable via a raw UPDATE here: allowing
-- pending -> accepted through this policy would let someone mark an
-- invite accepted without ever getting a project_members row (the two
-- writes need to happen atomically, which only accept_project_invite()
-- below guarantees). WITH CHECK pins the only reachable transition.
create policy "Invited users can decline their own pending invite"
  on public.project_invites for update
  using (status = 'pending' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (status = 'declined');

-- ---------------------------------------------------------------------
-- accept_project_invite: atomically flips a pending invite to accepted
-- and creates the caller's project_members row. SECURITY DEFINER because
-- the caller has no project_role yet at the moment they call this (that's
-- the whole point) — the insert policy above would otherwise reject them.
-- ---------------------------------------------------------------------
create or replace function public.accept_project_invite(p_token uuid)
returns public.project_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.project_invites;
  v_email text;
  v_member public.project_members;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    raise exception 'No authenticated email on this session.' using errcode = '28000';
  end if;

  select * into v_invite from public.project_invites where token = p_token for update;

  if v_invite is null then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending.' using errcode = '22023';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'This invite was sent to a different email address.' using errcode = '42501';
  end if;

  update public.project_invites
    set status = 'accepted', responded_at = now()
    where token = p_token;

  insert into public.project_members (project_id, user_id, role, invited_by, email)
    values (v_invite.project_id, auth.uid(), v_invite.role, v_invite.invited_by, v_email)
  on conflict (project_id, user_id) do update set role = excluded.role
  returning * into v_member;

  return v_member;
end;
$$;

-- ---------------------------------------------------------------------
-- Rewrite every existing policy to use project_role() instead of the raw
-- owner_id exists-check, changing WHO qualifies while preserving which
-- commands were previously allowed at all.
-- ---------------------------------------------------------------------

-- projects: viewer/editor/admin/owner can all read; only admin/owner can
-- update (Jira credentials + SLA policy live here). Insert/delete stay
-- owner-only, unchanged — no "transfer ownership"/"delete project"
-- feature in this pass.
drop policy if exists "Users can view their own projects" on public.projects;
create policy "Project members can view their projects"
  on public.projects for select
  using (public.project_role(id) is not null);

drop policy if exists "Users can update their own projects" on public.projects;
create policy "Owners and admins can update their projects"
  on public.projects for update
  using (public.project_role(id) in ('owner', 'admin'));

-- project_services: read by anyone with access; insert/delete normalized
-- to project_role() for consistency (no behavior change — only the
-- createProject flow ever touches these, always as owner).
drop policy if exists "Users can view services of their own projects" on public.project_services;
create policy "Project members can view services"
  on public.project_services for select
  using (public.project_role(project_id) is not null);

drop policy if exists "Users can insert services into their own projects" on public.project_services;
create policy "Owners can insert services"
  on public.project_services for insert
  with check (public.project_role(project_id) = 'owner');

drop policy if exists "Users can delete services from their own projects" on public.project_services;
create policy "Owners can delete services"
  on public.project_services for delete
  using (public.project_role(project_id) = 'owner');

-- scans: viewer reads; editor/admin/owner can upload + finalize.
drop policy if exists "Users can view scans of their own projects" on public.scans;
create policy "Project members can view scans"
  on public.scans for select
  using (public.project_role(project_id) is not null);

drop policy if exists "Users can insert scans into their own projects" on public.scans;
create policy "Editors and above can insert scans"
  on public.scans for insert
  with check (public.project_role(project_id) in ('owner', 'admin', 'editor'));

drop policy if exists "Users can update scans of their own projects" on public.scans;
create policy "Editors and above can update scans"
  on public.scans for update
  using (public.project_role(project_id) in ('owner', 'admin', 'editor'));

-- findings: viewer reads; editor/admin/owner can upsert + reassign bucket.
drop policy if exists "Users can view findings of their own projects" on public.findings;
create policy "Project members can view findings"
  on public.findings for select
  using (public.project_role(project_id) is not null);

drop policy if exists "Users can insert findings into their own projects" on public.findings;
create policy "Editors and above can insert findings"
  on public.findings for insert
  with check (public.project_role(project_id) in ('owner', 'admin', 'editor'));

drop policy if exists "Users can update findings of their own projects" on public.findings;
create policy "Editors and above can update findings"
  on public.findings for update
  using (public.project_role(project_id) in ('owner', 'admin', 'editor'));

-- tickets: viewer reads; editor/admin/owner can create/update/sync/delete.
-- (The insert policy is bypassed by create_project_ticket's SECURITY
-- DEFINER insert below in practice, but is kept for defense-in-depth.)
drop policy if exists "Users can view tickets of their own projects" on public.tickets;
create policy "Project members can view tickets"
  on public.tickets for select
  using (public.project_role(project_id) is not null);

drop policy if exists "Users can insert tickets into their own projects" on public.tickets;
create policy "Editors and above can insert tickets"
  on public.tickets for insert
  with check (public.project_role(project_id) in ('owner', 'admin', 'editor'));

drop policy if exists "Users can update tickets of their own projects" on public.tickets;
create policy "Editors and above can update tickets"
  on public.tickets for update
  using (public.project_role(project_id) in ('owner', 'admin', 'editor'));

drop policy if exists "Users can delete tickets of their own projects" on public.tickets;
create policy "Editors and above can delete tickets"
  on public.tickets for delete
  using (public.project_role(project_id) in ('owner', 'admin', 'editor'));

-- activity_events: viewer reads (append-only stays append-only — no
-- update/delete policy added, by design, unchanged from today).
drop policy if exists "Users can view activity of their own projects" on public.activity_events;
create policy "Project members can view activity"
  on public.activity_events for select
  using (public.project_role(project_id) is not null);

drop policy if exists "Users can insert activity into their own projects" on public.activity_events;
create policy "Editors and above can insert activity"
  on public.activity_events for insert
  with check (public.project_role(project_id) in ('owner', 'admin', 'editor'));

-- ---------------------------------------------------------------------
-- create_project_ticket: now SECURITY DEFINER so it can claim ticket_seq
-- via an UPDATE on projects even though projects' own UPDATE policy is
-- now admin/owner-only. Decouples "who can claim a ticket key" from "who
-- can edit project settings" via an explicit internal role check.
-- ---------------------------------------------------------------------
create or replace function public.create_project_ticket(
  p_project_id uuid,
  p_finding_id uuid,
  p_title text,
  p_service text,
  p_severity text,
  p_due_date date
) returns public.tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_seq integer;
  v_prefix text;
  v_ticket public.tickets;
begin
  v_role := public.project_role(p_project_id);
  if v_role is null or v_role not in ('owner', 'admin', 'editor') then
    raise exception 'Editor access required to create tickets' using errcode = '42501';
  end if;

  update public.projects
    set ticket_seq = ticket_seq + 1
    where id = p_project_id
    returning ticket_seq, key_prefix into v_seq, v_prefix;

  if v_seq is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;

  insert into public.tickets (project_id, finding_id, key, title, service, severity, due_date)
  values (p_project_id, p_finding_id, coalesce(v_prefix, 'PRJ') || '-' || (100 + v_seq), p_title, p_service, p_severity, p_due_date)
  returning * into v_ticket;

  return v_ticket;
end;
$$;

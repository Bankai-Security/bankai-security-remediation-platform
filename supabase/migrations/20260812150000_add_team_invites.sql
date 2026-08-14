-- Team membership invitations, mirroring org_invites (20260812130000) exactly:
-- a team_invites table + an accept_team_invite() SECURITY DEFINER RPC, so a
-- team admin can invite by email without an email->user_id lookup — the user_id
-- is resolved from the invitee's own JWT at accept time.
--
-- team_role() caps at 'admin' (it never returns 'owner' — see the hierarchy
-- migration), so the admin-visibility checks below use `= 'admin'` where the
-- org_invites equivalents used `in ('owner','admin')`.

-- team_members gains the same two columns org_members already carries: `email`
-- (denormalized snapshot captured at accept time; profiles has no email column)
-- and `invited_by`. Nullable, since this ALTERs an existing table; every row
-- created through accept_team_invite() always populates email.
alter table public.team_members add column if not exists email text;
alter table public.team_members
  add column if not exists invited_by uuid references public.profiles (id) on delete set null;

-- team_invites: pending/resolved invitations by email + a shareable token.
-- Manual link-sharing only — no email is ever sent by this app.
create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  token uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists team_invites_team_id_idx on public.team_invites (team_id);

-- Only one *pending* invite per (team, email) at a time.
create unique index if not exists team_invites_pending_email_idx
  on public.team_invites (team_id, lower(email))
  where status = 'pending';

-- RLS: team_invites ----------------------------------------------------
alter table public.team_invites enable row level security;

-- Each policy is dropped first so this file can be re-run (CREATE POLICY has
-- no IF NOT EXISTS).
drop policy if exists "Team admins can view invites for their team" on public.team_invites;
create policy "Team admins can view invites for their team"
  on public.team_invites for select
  using (public.team_role(team_id) = 'admin');

-- Matches the invitee's own JWT email claim — they aren't a team member yet, so
-- team_role() would return null for them; a separate, non-membership condition.
drop policy if exists "Invited users can view their own pending team invites" on public.team_invites;
create policy "Invited users can view their own pending team invites"
  on public.team_invites for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists "Team admins can create team invites" on public.team_invites;
create policy "Team admins can create team invites"
  on public.team_invites for insert
  with check (public.team_role(team_id) = 'admin');

drop policy if exists "Team admins can revoke team invites" on public.team_invites;
create policy "Team admins can revoke team invites"
  on public.team_invites for update
  using (public.team_role(team_id) = 'admin')
  with check (public.team_role(team_id) = 'admin');

-- Invitees may self-service ONLY a decline directly; acceptance goes through
-- accept_team_invite() so the membership writes stay atomic.
drop policy if exists "Invited users can decline their own pending team invite" on public.team_invites;
create policy "Invited users can decline their own pending team invite"
  on public.team_invites for update
  using (status = 'pending' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (status = 'declined');

-- accept_team_invite: atomically flips a pending invite to accepted and creates
-- the caller's team_members row. SECURITY DEFINER because the caller has no
-- team_role yet at call time. In addition, it upserts an org_members *viewer*
-- row for the team's org if the caller isn't already an org member/owner — you
-- can't be in a team but invisible to its org, so a team invitee needs at least
-- viewer visibility on the parent org to navigate the hierarchy. Existing org
-- roles are never downgraded (on conflict do nothing).
create or replace function public.accept_team_invite(p_token uuid)
returns public.team_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.team_invites;
  v_email text;
  v_org_id uuid;
  v_member public.team_members;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    raise exception 'No authenticated email on this session.' using errcode = '28000';
  end if;

  select * into v_invite from public.team_invites where token = p_token for update;

  if v_invite is null then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending.' using errcode = '22023';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'This invite was sent to a different email address.' using errcode = '42501';
  end if;

  update public.team_invites
    set status = 'accepted', responded_at = now()
    where token = p_token;

  -- Ensure the caller can see the parent org (at least viewer). owner_id and
  -- any existing org_members grant are left untouched.
  select org_id into v_org_id from public.teams where id = v_invite.team_id;
  insert into public.org_members (org_id, user_id, role, email)
    values (v_org_id, auth.uid(), 'viewer', v_email)
  on conflict (org_id, user_id) do nothing;

  insert into public.team_members (team_id, user_id, role, invited_by, email)
    values (v_invite.team_id, auth.uid(), v_invite.role, v_invite.invited_by, v_email)
  on conflict (team_id, user_id) do update set role = excluded.role
  returning * into v_member;

  return v_member;
end;
$$;

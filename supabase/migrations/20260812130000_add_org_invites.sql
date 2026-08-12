-- Org membership invitations, mirroring the project sharing model exactly:
-- an org_invites table + an accept_org_invite() SECURITY DEFINER RPC, so an
-- admin can invite by email without an email->user_id lookup — the user_id is
-- resolved from the invitee's own JWT at accept time. This is the direct
-- counterpart to project_invites / accept_project_invite() in the
-- 20260717200000 migration.

-- org_members gains the same two columns project_members already carries:
-- `email` is a denormalized snapshot captured at accept time (profiles has no
-- email column, so listing members would otherwise need a service-role lookup
-- per row), and `invited_by` records who sent the invite. Added nullable
-- rather than NOT NULL because this ALTERs a table that already exists; every
-- row created through accept_org_invite() below always populates email.
alter table public.org_members add column if not exists email text;
alter table public.org_members
  add column if not exists invited_by uuid references public.profiles (id) on delete set null;

-- org_invites: pending/resolved invitations by email + a shareable token.
-- Manual link-sharing only — no email is ever sent by this app.
create table if not exists public.org_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  token uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'revoked')),
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists org_invites_org_id_idx on public.org_invites (org_id);

-- Only one *pending* invite per (org, email) at a time — re-inviting after a
-- decline/revoke is fine since that row's status is no longer 'pending'.
create unique index if not exists org_invites_pending_email_idx
  on public.org_invites (org_id, lower(email))
  where status = 'pending';

-- RLS: org_invites -----------------------------------------------------
alter table public.org_invites enable row level security;

create policy "Org owners and admins can view invites for their org"
  on public.org_invites for select
  using (public.org_role(org_id) in ('owner', 'admin'));

-- Matches the invitee's own JWT email claim — they aren't an org member yet,
-- so org_role() would return null for them; this is a separate, non-membership
-- auth condition (mirrors the project_invites invitee-visibility policy).
create policy "Invited users can view their own pending org invites"
  on public.org_invites for select
  using (lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));

create policy "Org owners and admins can create org invites"
  on public.org_invites for insert
  with check (public.org_role(org_id) in ('owner', 'admin'));

create policy "Org owners and admins can revoke org invites"
  on public.org_invites for update
  using (public.org_role(org_id) in ('owner', 'admin'))
  with check (public.org_role(org_id) in ('owner', 'admin'));

-- Invitees may self-service ONLY a decline directly. Acceptance is
-- deliberately NOT reachable via a raw UPDATE — pending -> accepted must
-- happen atomically with the org_members insert, which only
-- accept_org_invite() below guarantees. WITH CHECK pins the only reachable
-- transition to 'declined'.
create policy "Invited users can decline their own pending org invite"
  on public.org_invites for update
  using (status = 'pending' and lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')))
  with check (status = 'declined');

-- accept_org_invite: atomically flips a pending invite to accepted and creates
-- the caller's org_members row. SECURITY DEFINER because the caller has no
-- org_role yet at the moment they call this (that's the whole point) — the
-- insert policy above would otherwise reject them. Direct counterpart to
-- accept_project_invite().
create or replace function public.accept_org_invite(p_token uuid)
returns public.org_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.org_invites;
  v_email text;
  v_member public.org_members;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then
    raise exception 'No authenticated email on this session.' using errcode = '28000';
  end if;

  select * into v_invite from public.org_invites where token = p_token for update;

  if v_invite is null then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;

  if v_invite.status <> 'pending' then
    raise exception 'This invite is no longer pending.' using errcode = '22023';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'This invite was sent to a different email address.' using errcode = '42501';
  end if;

  update public.org_invites
    set status = 'accepted', responded_at = now()
    where token = p_token;

  insert into public.org_members (org_id, user_id, role, invited_by, email)
    values (v_invite.org_id, auth.uid(), v_invite.role, v_invite.invited_by, v_email)
  on conflict (org_id, user_id) do update set role = excluded.role
  returning * into v_member;

  return v_member;
end;
$$;

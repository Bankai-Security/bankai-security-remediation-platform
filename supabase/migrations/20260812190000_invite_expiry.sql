-- Invite lifecycle: invitations expire after 14 days. Until now a pending
-- invite token lived forever. Adds expires_at to all three invite tables
-- (existing pending rows get 14 days from when this migration runs) and
-- re-creates the three accept RPCs with an expiry check. Expired invites are
-- surfaced as such in the UI and can be re-issued via the resend endpoint
-- (revoke + fresh token/expiry) — the pending-email partial unique index
-- still treats an expired-but-pending row as blocking, by design, so resend
-- is the one path to a new link.

alter table public.project_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days');
alter table public.org_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days');
alter table public.team_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '14 days');

-- ---------------------------------------------------------------------
-- accept_project_invite: unchanged from 20260717200000 except the expiry
-- check after the pending-status check.
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

  if v_invite.expires_at < now() then
    raise exception 'This invite has expired.' using errcode = '22023';
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
-- accept_org_invite: unchanged from 20260812130000 except the expiry check.
-- ---------------------------------------------------------------------
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

  if v_invite.expires_at < now() then
    raise exception 'This invite has expired.' using errcode = '22023';
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

-- ---------------------------------------------------------------------
-- accept_team_invite: unchanged from 20260812150000 (incl. the org-viewer
-- upsert) except the expiry check.
-- ---------------------------------------------------------------------
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

  if v_invite.expires_at < now() then
    raise exception 'This invite has expired.' using errcode = '22023';
  end if;

  if lower(v_invite.email) <> v_email then
    raise exception 'This invite was sent to a different email address.' using errcode = '42501';
  end if;

  update public.team_invites
    set status = 'accepted', responded_at = now()
    where token = p_token;

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

-- Membership self-service: let people leave orgs/teams on their own, and let
-- an org owner hand ownership to someone else. Previously the only way out of
-- an org was for an admin to remove you, and ownership was a bare owner_id
-- with no transfer path — so deleting the owner's account took the whole org
-- (and everyone's access) with it.

-- Leaving: a member may always delete their OWN membership row. Admin removal
-- of other people is unchanged (the existing owner/admin DELETE policies).
-- Note the org owner has no org_members row at all, so they can't "leave" —
-- they must transfer ownership first, which the API surfaces as a 422.
-- Dropped first so this file can be re-run (CREATE POLICY has no IF NOT EXISTS).
drop policy if exists "Members can leave an organization" on public.org_members;
create policy "Members can leave an organization"
  on public.org_members for delete
  using (user_id = auth.uid());

drop policy if exists "Members can leave a team" on public.team_members;
create policy "Members can leave a team"
  on public.team_members for delete
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- transfer_org_ownership: hand the org to an existing member, demoting the
-- outgoing owner to admin so they don't lose access to their own org.
-- SECURITY DEFINER because it writes organizations.owner_id — the
-- organizations UPDATE policy allows owner/admin, but the org_members writes
-- below also need to happen atomically with it, and the caller must not be
-- able to do half of this by hand.
-- Raises:
--   42501 — caller is not the current owner
--   P0002 — the target isn't a member of this org
-- ---------------------------------------------------------------------
create or replace function public.transfer_org_ownership(p_org_id uuid, p_to_user uuid)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations;
begin
  select * into v_org from public.organizations where id = p_org_id for update;

  if v_org is null then
    raise exception 'Organization not found' using errcode = 'P0002';
  end if;

  if v_org.owner_id <> auth.uid() then
    raise exception 'Only the organization owner can transfer ownership.' using errcode = '42501';
  end if;

  if p_to_user = v_org.owner_id then
    raise exception 'That user already owns this organization.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.org_members m where m.org_id = p_org_id and m.user_id = p_to_user
  ) then
    raise exception 'That user is not a member of this organization.' using errcode = 'P0002';
  end if;

  -- The outgoing owner becomes an admin member; the incoming owner's member
  -- row is removed, since ownership is expressed by owner_id, not membership.
  insert into public.org_members (org_id, user_id, role, email)
    values (
      p_org_id,
      v_org.owner_id,
      'admin',
      lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  on conflict (org_id, user_id) do update set role = 'admin';

  delete from public.org_members where org_id = p_org_id and user_id = p_to_user;

  update public.organizations set owner_id = p_to_user where id = p_org_id
    returning * into v_org;

  return v_org;
end;
$$;

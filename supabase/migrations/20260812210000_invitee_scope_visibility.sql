-- Let a pending invitee read the name of the thing they were invited to.
--
-- The invite-listing endpoints embed the scope row (organizations / teams /
-- projects) so the invite bell and the accept page can say "Join Acme". The
-- invitee can read the INVITE row (their own email matches the invitee policy)
-- but the embedded scope row is filtered by that table's own SELECT policy,
-- which requires membership — exactly what an invitee doesn't have yet. The
-- embed therefore came back null and the API fell through to its
-- "Unknown organization" / "Unknown team" / "Unknown project" placeholders.
--
-- Each policy below is additive: RLS policies for the same command are OR'd,
-- so existing member access is unchanged. Visibility is scoped tightly — the
-- invite must be pending, unexpired, and addressed to the caller's own JWT
-- email — and it ends the moment the invite is accepted, declined, revoked, or
-- expires (at which point membership grants access instead, if accepted).
--
-- No recursion: these subqueries read the *_invites tables, whose own policies
-- only call the SECURITY DEFINER role helpers (project_role/org_role/
-- team_role). Those run as the table owner, so RLS is bypassed inside them and
-- evaluation doesn't re-enter the policies being defined here.

-- ---------------------------------------------------------------------
-- organizations: visible to someone holding a pending org invite.
-- ---------------------------------------------------------------------
-- The policy table's column is qualified (organizations.id) throughout: the
-- invite tables have their own `id`, so a bare `id` here is ambiguous.
drop policy if exists "Invited users can view the organization they were invited to" on public.organizations;
create policy "Invited users can view the organization they were invited to"
  on public.organizations for select
  using (exists (
    select 1 from public.org_invites i
    where i.org_id = organizations.id
      and i.status = 'pending'
      and i.expires_at > now()
      and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

-- ---------------------------------------------------------------------
-- teams: visible to someone holding a pending team invite. The team-invite
-- payload also embeds the team's organization, so the org policy above is
-- extended to cover "invited to a team inside this org" as well — otherwise
-- the accept page would read "Join Platform in Unknown organization".
-- ---------------------------------------------------------------------
drop policy if exists "Invited users can view the team they were invited to" on public.teams;
create policy "Invited users can view the team they were invited to"
  on public.teams for select
  using (exists (
    select 1 from public.team_invites i
    where i.team_id = teams.id
      and i.status = 'pending'
      and i.expires_at > now()
      and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

drop policy if exists "Invited users can view the org of a team they were invited to" on public.organizations;
create policy "Invited users can view the org of a team they were invited to"
  on public.organizations for select
  using (exists (
    select 1 from public.team_invites i
    join public.teams t on t.id = i.team_id
    where t.org_id = organizations.id
      and i.status = 'pending'
      and i.expires_at > now()
      and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

-- ---------------------------------------------------------------------
-- projects: the same defect predates the org/team work — the project invite
-- accept page has always been able to render "Join Unknown project" for a
-- non-member invitee. Fixed here for parity.
-- ---------------------------------------------------------------------
drop policy if exists "Invited users can view the project they were invited to" on public.projects;
create policy "Invited users can view the project they were invited to"
  on public.projects for select
  using (exists (
    select 1 from public.project_invites i
    where i.project_id = projects.id
      and i.status = 'pending'
      and i.expires_at > now()
      and lower(i.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ));

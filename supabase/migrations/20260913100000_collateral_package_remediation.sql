-- A verified dependency change may remediate more than the ticket that
-- initiated it. Persist the exact scanner comparison and explicit resolution
-- provenance instead of pretending every affected ticket owned the same PR.

create table if not exists public.remediation_security_verifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  commit_sha text not null,
  scanner text not null,
  baseline_findings jsonb not null default '[]'::jsonb,
  current_findings jsonb not null default '[]'::jsonb,
  verified_at timestamptz not null default now(),
  unique (ticket_id, commit_sha, scanner)
);

create index if not exists remediation_security_verifications_project_idx
  on public.remediation_security_verifications (project_id, verified_at desc);

alter table public.remediation_security_verifications enable row level security;

create policy "Users can view remediation security verifications of their projects"
  on public.remediation_security_verifications for select
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));

create table if not exists public.finding_resolution_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  finding_id uuid not null references public.findings (id) on delete cascade,
  ticket_id uuid references public.tickets (id) on delete set null,
  resolution_type text not null check (
    resolution_type in ('collateral_package_upgrade', 'collateral_package_removal')
  ),
  source_ticket_id uuid not null references public.tickets (id) on delete restrict,
  source_pr_number integer not null,
  source_commit_sha text not null,
  verification_id uuid not null references public.remediation_security_verifications (id) on delete restrict,
  package_identity text not null,
  advisory_id text not null,
  previous_version text,
  resolved_at timestamptz not null default now(),
  unique (finding_id, verification_id)
);

create index if not exists finding_resolution_events_finding_idx
  on public.finding_resolution_events (finding_id, resolved_at desc);

alter table public.finding_resolution_events enable row level security;

create policy "Users can view finding resolution events of their projects"
  on public.finding_resolution_events for select
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));

alter table public.tickets
  add column if not exists collateral_resolution_event_id uuid
  references public.finding_resolution_events (id) on delete set null;
alter table public.tickets add column if not exists security_verified_commit_sha text;

-- Keep the original direct-remediation gate and add a second, explicit path
-- backed by immutable scanner evidence. A normal rescan omission still cannot
-- complete a ticket.
create or replace function public.enforce_ticket_completion_gate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'Done'
     and ((new.github_pr_state = 'merged' and new.ci_status = 'passed') is not true)
     and new.collateral_resolution_event_id is null then
    new.status := case
      when new.github_pr_number is not null then 'In Review'
      else 'In Progress'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ticket_completion_gate on public.tickets;

create trigger enforce_ticket_completion_gate
  before insert or update of status, github_pr_number, github_pr_state, ci_status, collateral_resolution_event_id
  on public.tickets
  for each row execute function public.enforce_ticket_completion_gate();

comment on function public.enforce_ticket_completion_gate() is
  'Allows Done only after direct merged/verified remediation or an explicit collateral package-resolution event.';

create or replace function public.apply_collateral_package_resolution(
  p_project_id uuid,
  p_finding_id uuid,
  p_ticket_id uuid,
  p_resolution_type text,
  p_source_ticket_id uuid,
  p_source_pr_number integer,
  p_source_commit_sha text,
  p_verification_id uuid,
  p_package_identity text,
  p_advisory_id text,
  p_previous_version text,
  p_rationale text
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  if p_resolution_type not in ('collateral_package_upgrade', 'collateral_package_removal') then
    raise exception 'Invalid collateral resolution type';
  end if;

  if not exists (
    select 1
    from public.tickets t
    join public.remediation_security_verifications v
      on v.id = p_verification_id and v.ticket_id = t.id
    where t.id = p_source_ticket_id
      and t.project_id = p_project_id
      and t.github_pr_state = 'merged'
      and t.ci_status = 'passed'
      and t.github_pr_number = p_source_pr_number
      and t.security_verified_commit_sha = p_source_commit_sha
      and v.commit_sha = p_source_commit_sha
  ) then
    raise exception 'Collateral resolution evidence is not complete';
  end if;

  insert into public.finding_resolution_events (
    project_id, finding_id, ticket_id, resolution_type, source_ticket_id,
    source_pr_number, source_commit_sha, verification_id, package_identity,
    advisory_id, previous_version
  ) values (
    p_project_id, p_finding_id, p_ticket_id, p_resolution_type, p_source_ticket_id,
    p_source_pr_number, p_source_commit_sha, p_verification_id, p_package_identity,
    p_advisory_id, p_previous_version
  )
  on conflict (finding_id, verification_id) do update
    set package_identity = excluded.package_identity
  returning id into v_event_id;

  update public.findings
  set bucket = 'Resolved', rationale = p_rationale
  where id = p_finding_id and project_id = p_project_id and bucket <> 'Resolved';

  if not found then
    return null;
  end if;

  update public.tickets
  set status = 'Done', collateral_resolution_event_id = v_event_id
  where id = p_ticket_id and project_id = p_project_id and finding_id = p_finding_id;

  if not found then
    raise exception 'Collateral ticket does not match finding';
  end if;

  return v_event_id;
end;
$$;

comment on function public.apply_collateral_package_resolution is
  'Atomically records verified collateral evidence and resolves its finding and ticket.';

-- SCRUM-29/34 Bankai-side immutable storage for a Quincy verification result.
create table public.remediation_verification_manifests (
  attempt_id uuid primary key references public.remediation_attempts(id) on delete restrict,
  manifest_id text not null unique check (length(manifest_id) between 1 and 128),
  execution_id text not null unique check (length(execution_id) between 1 and 128),
  manifest_digest text not null check (manifest_digest ~ '^sha256-[0-9a-f]{64}$'),
  manifest jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.remediation_verification_manifests enable row level security;
create policy remediation_manifest_owner_read on public.remediation_verification_manifests for select
  using (exists(select 1 from public.remediation_attempts a join public.remediations r on r.id=a.remediation_id
    join public.projects p on p.id=r.project_id where a.id=attempt_id and p.owner_id=auth.uid()));
revoke all on public.remediation_verification_manifests from public, anon, authenticated, service_role;
grant select on public.remediation_verification_manifests to authenticated, service_role;
grant insert on public.remediation_verification_manifests to service_role;

create function public.prevent_remediation_verification_manifest_mutation() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'verification manifests are immutable'; end $$;
create trigger remediation_verification_manifest_immutable before update or delete
  on public.remediation_verification_manifests for each row
  execute function public.prevent_remediation_verification_manifest_mutation();

create function public.validate_remediation_verification_manifest() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.remediation_attempts%rowtype; r public.remediations%rowtype;
begin
  select * into a from public.remediation_attempts where id=new.attempt_id;
  select * into r from public.remediations where id=a.remediation_id;
  if a.id is null or r.id is null or a.quincy_job_id is distinct from new.execution_id
    or new.manifest->>'execution_id' is distinct from new.execution_id
    or new.manifest->>'manifest_id' is distinct from new.manifest_id
    or new.manifest->>'integrity_digest' is distinct from new.manifest_digest
    or new.manifest->>'repository' is distinct from ('github_url:https://github.com/' || r.repository_id)
    or new.manifest->>'candidate_sha' is distinct from a.candidate_sha
    or new.manifest->>'baseline_sha' is distinct from a.base_sha
    or new.manifest->>'profile' is distinct from a.verification_profile
    or new.manifest#>>'{bankai_correlation,remediation_id}' is distinct from r.id::text
    or new.manifest#>>'{bankai_correlation,attempt_id}' is distinct from a.id::text
    or new.manifest#>>'{bankai_correlation,finding_id}' is distinct from r.finding_id::text
    or new.manifest#>>'{bankai_correlation,base_sha}' is distinct from a.base_sha then
    raise exception 'verification manifest does not match its remediation attempt';
  end if;
  return new;
end $$;
revoke all on function public.validate_remediation_verification_manifest() from public, anon, authenticated;
create trigger remediation_verification_manifest_validate before insert on public.remediation_verification_manifests
  for each row execute function public.validate_remediation_verification_manifest();

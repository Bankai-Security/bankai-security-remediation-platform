-- SCRUM-31: link immutable generated-diff references to SCRUM-30 attempts.
create table public.remediation_patch_artifacts (
  attempt_id uuid primary key references public.remediation_attempts(id) on delete restrict,
  finding_id uuid not null references public.findings(id) on delete restrict,
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  candidate_sha text not null check (candidate_sha ~ '^[0-9a-f]{40}$' and candidate_sha <> base_sha),
  patch_digest text not null check (patch_digest ~ '^sha256-[0-9a-f]{64}$'),
  diff_ref text not null check (diff_ref ~ '^https://github\.com/.+/compare/[0-9a-f]{40}\.\.\.[0-9a-f]{40}\.diff$'),
  created_at timestamptz not null default now()
);
alter table public.remediation_patch_artifacts enable row level security;
create policy remediation_patch_artifact_owner_read on public.remediation_patch_artifacts for select
  using (exists(select 1 from public.remediation_attempts a join public.remediations r on r.id = a.remediation_id
    join public.projects p on p.id = r.project_id where a.id = attempt_id and p.owner_id = auth.uid()));
revoke all on public.remediation_patch_artifacts from public, anon, authenticated, service_role;
grant select on public.remediation_patch_artifacts to authenticated, service_role;
grant insert on public.remediation_patch_artifacts to service_role;

create function public.prevent_remediation_patch_artifact_mutation() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'remediation patch artifacts are immutable';
end $$;
create trigger remediation_patch_artifact_immutable before update or delete on public.remediation_patch_artifacts
  for each row execute function public.prevent_remediation_patch_artifact_mutation();

create function public.validate_remediation_patch_artifact() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.remediation_attempts%rowtype; r public.remediations%rowtype;
begin
  select * into a from public.remediation_attempts where id = new.attempt_id;
  select * into r from public.remediations where id = a.remediation_id;
  if a.id is null or r.finding_id <> new.finding_id or a.base_sha <> new.base_sha or a.candidate_sha <> new.candidate_sha or a.patch_digest <> new.patch_digest
    or new.diff_ref <> ('https://github.com/' || r.repository_id || '/compare/' || new.base_sha || '...' || new.candidate_sha || '.diff') then
    raise exception 'patch artifact does not match its remediation attempt';
  end if;
  return new;
end $$;
revoke all on function public.validate_remediation_patch_artifact() from public, anon, authenticated;
create trigger remediation_patch_artifact_validate before insert on public.remediation_patch_artifacts
  for each row execute function public.validate_remediation_patch_artifact();

-- SCRUM-34: remediation rows retain owner/repo for GitHub URLs while Quincy
-- evidence uses its derived repository identity. Bind the existing VERIFIED
-- checks to the deterministic Quincy identity without changing scan contracts.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.quincy_repository_identity(repository_locator text) returns text
language sql immutable strict set search_path = public, extensions, pg_temp as $$
  select 'quincy-repository-' || encode(extensions.digest(
    convert_to('github_url:https://github.com/' || repository_locator, 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function public.quincy_repository_identity(text) from public, anon, authenticated;

do $$
declare
  definition text;
  original text;
begin
  definition := pg_get_functiondef('public.remediation_command_v1_transition_engine(jsonb)'::regprocedure);
  original := definition;
  if position('b.repository_id is distinct from r.repository_id' in definition) = 0
    or position('c.repository_id is distinct from r.repository_id' in definition) = 0
    or position('comparison->>''repository_id'' is distinct from r.repository_id' in definition) = 0 then
    raise exception 'repository identity checks changed; review SCRUM-34 migration';
  end if;
  definition := replace(definition, 'b.repository_id is distinct from r.repository_id',
    'b.repository_id is distinct from public.quincy_repository_identity(r.repository_id)');
  definition := replace(definition, 'c.repository_id is distinct from r.repository_id',
    'c.repository_id is distinct from public.quincy_repository_identity(r.repository_id)');
  definition := replace(definition, 'comparison->>''repository_id'' is distinct from r.repository_id',
    'comparison->>''repository_id'' is distinct from public.quincy_repository_identity(r.repository_id)');
  if position('a.quincy_job_id := p_command->>''quincy_job_id'';' in definition) = 0 then
    raise exception 'could not locate verification identity assignment in remediation transition engine';
  end if;
  definition := replace(definition,
    'a.quincy_job_id := p_command->>''quincy_job_id'';',
    'a.quincy_job_id := p_command->>''quincy_job_id''; a.jenkins_build_id := p_command->>''jenkins_build_id'';');
  if position('a.jenkins_build_id := p_command->>''jenkins_build_id'';' in definition) = 0
    or position('b.repository_id is distinct from public.quincy_repository_identity(r.repository_id)' in definition) = 0
    or position('c.repository_id is distinct from public.quincy_repository_identity(r.repository_id)' in definition) = 0
    or position('comparison->>''repository_id'' is distinct from public.quincy_repository_identity(r.repository_id)' in definition) = 0 then
    raise exception 'SCRUM-34 state-machine binding rewrite did not apply completely';
  end if;
  if definition = original then
    raise exception 'could not locate all repository identity checks in remediation transition engine';
  end if;
  execute definition;
end $$;

-- The state-machine RPC cannot mark an attempt VERIFIED unless its immutable
-- manifest is finalized for the exact Quincy/Jenkins/scan identities.
create or replace function public.require_remediation_verification_manifest() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.remediations%rowtype; m public.remediation_verification_manifests%rowtype;
begin
  if new.state <> 'VERIFIED' then return new; end if;
  select * into r from public.remediations where id=new.remediation_id;
  select * into m from public.remediation_verification_manifests where attempt_id=new.id;
  if m.attempt_id is null or m.execution_id is distinct from new.quincy_job_id
    or m.manifest_id is distinct from m.manifest->>'manifest_id'
    or m.manifest_digest is distinct from m.manifest#>>'{integrity_digest}'
    or m.manifest->>'state' is distinct from 'passed'
    or m.manifest->>'execution_id' is distinct from new.quincy_job_id
    or m.manifest->>'candidate_sha' is distinct from new.candidate_sha
    or m.manifest->>'baseline_sha' is distinct from new.base_sha
    or m.manifest->>'profile' is distinct from new.verification_profile
    or m.manifest->>'scan_execution_id' is distinct from new.quincy_scan_execution_id
    or m.manifest->>'jenkins_build_id' is distinct from new.jenkins_build_id
    or m.manifest->>'policy_id' is distinct from 'bankai-complete-repository-differential-v1'
    or m.manifest->>'repository_id' is distinct from public.quincy_repository_identity(r.repository_id)
    or m.manifest->>'repository' is distinct from ('github_url:https://github.com/' || r.repository_id)
    or m.manifest#>>'{bankai_correlation,remediation_id}' is distinct from r.id::text
    or m.manifest#>>'{bankai_correlation,attempt_id}' is distinct from new.id::text
    or m.manifest#>>'{bankai_correlation,finding_id}' is distinct from r.finding_id::text
    or m.manifest#>>'{bankai_correlation,base_sha}' is distinct from new.base_sha then
    raise exception 'immutable Quincy manifest missing or mismatched';
  end if;
  return new;
end $$;
revoke all on function public.require_remediation_verification_manifest() from public, anon, authenticated;
create trigger remediation_attempt_verified_manifest before update of state on public.remediation_attempts
  for each row when (new.state='VERIFIED') execute function public.require_remediation_verification_manifest();

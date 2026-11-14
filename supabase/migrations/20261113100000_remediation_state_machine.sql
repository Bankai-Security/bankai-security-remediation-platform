-- SCRUM-30: additive, service-owned remediation persistence. Existing tickets,
-- evidence formats and completion gates remain unchanged.
create table public.remediations (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null default '1.0' check (schema_version = '1.0'),
  project_id uuid not null references public.projects(id) on delete restrict,
  finding_id uuid not null references public.findings(id) on delete restrict,
  repository_id text not null check (length(repository_id) > 0),
  state text not null default 'DISCOVERED' check (state in ('DISCOVERED','TRIAGED','PATCH_GENERATED','VERIFICATION_PENDING','VERIFYING','VERIFICATION_FAILED','PATCH_REVISION','VERIFIED','PR_PUBLISHED','CANCELLED','ESCALATED','BLOCKED','VERIFICATION_INCOMPLETE')),
  retry_limit integer not null default 2 check (retry_limit between 0 and 20),
  attempt_count integer not null default 0,
  revision integer not null default 0,
  current_attempt_id uuid,
  failure_classification text,
  diagnostic text,
  create_key text not null,
  create_request jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, create_key)
);
create table public.remediation_attempts (
  id uuid primary key default gen_random_uuid(),
  remediation_id uuid not null references public.remediations(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  state text not null,
  patch_digest text not null check (patch_digest ~ '^sha256-[0-9a-f]{64}$'),
  base_sha text not null check (base_sha ~ '^[0-9a-f]{40}$'),
  candidate_sha text not null check (candidate_sha ~ '^[0-9a-f]{40}$' and candidate_sha <> base_sha),
  verification_profile text not null check (length(verification_profile) > 0),
  quincy_job_id text,
  quincy_scan_execution_id text,
  jenkins_build_id text,
  verification_id uuid references public.remediation_security_verifications(id) on delete restrict,
  baseline_evidence_id uuid references public.quincy_scan_evidence(id) on delete restrict,
  candidate_evidence_id uuid references public.quincy_scan_evidence(id) on delete restrict,
  failure_classification text,
  diagnostic text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(remediation_id, attempt_number)
);
alter table public.remediations add constraint remediations_current_attempt_fk foreign key(current_attempt_id) references public.remediation_attempts(id) on delete restrict;
create table public.remediation_events (
  id bigint generated always as identity primary key,
  remediation_id uuid not null references public.remediations(id) on delete restrict,
  attempt_id uuid references public.remediation_attempts(id) on delete restrict,
  command_key text not null,
  command jsonb not null,
  from_state text,
  to_state text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique(remediation_id, command_key)
);
create index remediations_recovery_idx on public.remediations(state, updated_at);
alter table public.remediations enable row level security;
alter table public.remediation_attempts enable row level security;
alter table public.remediation_events enable row level security;
create policy remediation_owner_read on public.remediations for select using (exists(select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy attempt_owner_read on public.remediation_attempts for select using (exists(select 1 from public.remediations r join public.projects p on p.id = r.project_id where r.id = remediation_id and p.owner_id = auth.uid()));
create policy event_owner_read on public.remediation_events for select using (exists(select 1 from public.remediations r join public.projects p on p.id = r.project_id where r.id = remediation_id and p.owner_id = auth.uid()));
-- Even service workers use the RPC; direct edits cannot bypass transition checks.
revoke all on public.remediations, public.remediation_attempts, public.remediation_events from public, anon, authenticated, service_role;
grant select on public.remediations, public.remediation_attempts, public.remediation_events to authenticated, service_role;

create function public.remediation_command(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.remediations%rowtype;
  a public.remediation_attempts%rowtype;
  e public.remediation_events%rowtype;
  v public.remediation_security_verifications%rowtype;
  b public.quincy_scan_evidence%rowtype;
  c public.quincy_scan_evidence%rowtype;
  f public.findings%rowtype;
  target_state text;
  old_state text;
  result jsonb;
  comparison jsonb;
  matches integer;
begin
  if p_command->>'schema_version' is distinct from '1.0' or coalesce(length(p_command->>'command_key'),0) not between 1 and 128 then
    raise exception 'invalid command version or idempotency key';
  end if;
  if p_command->>'action' = 'create' then
    select * into f from public.findings where id = (p_command->>'finding_id')::uuid and project_id = (p_command->>'project_id')::uuid;
    if not found then raise exception 'finding/project mismatch'; end if;
    insert into public.remediations(project_id,finding_id,repository_id,retry_limit,create_key,create_request,revision)
      values(f.project_id,f.id,p_command->>'repository_id',coalesce((p_command->>'retry_limit')::integer,2),p_command->>'command_key',p_command,1)
      on conflict(project_id,create_key) do nothing;
    select * into r from public.remediations where project_id = f.project_id and create_key = p_command->>'command_key' for update;
    if r.create_request <> p_command then raise exception 'idempotency key reused with different command'; end if;
    select response into result from public.remediation_events where remediation_id = r.id and command_key = p_command->>'command_key';
    if found then return result; end if;
    old_state := r.state;
  else
    select * into r from public.remediations where id = (p_command->>'remediation_id')::uuid for update;
    if not found then raise exception 'remediation not found'; end if;
    select * into e from public.remediation_events where remediation_id = r.id and command_key = p_command->>'command_key';
    if found then
      if e.command <> p_command then raise exception 'idempotency key reused with different command'; end if;
      return e.response;
    end if;
    if (p_command->>'expected_revision')::integer is distinct from r.revision then raise exception 'stale remediation revision'; end if;
    old_state := r.state;
    if p_command->>'action' = 'start_attempt' then
      if r.state not in ('TRIAGED','PATCH_REVISION') then raise exception 'attempt cannot start from %',r.state; end if;
      if r.attempt_count >= r.retry_limit + 1 then
        r.state := 'ESCALATED';
        r.failure_classification := 'retry_exhausted';
        r.diagnostic := 'Configured remediation retry limit exhausted; human review required.';
        -- Exhaustion is an auditable terminal transition. Keep it on the
        -- current attempt instead of silently changing only the parent row.
        select * into a from public.remediation_attempts where id = r.current_attempt_id for update;
        if a.id is not null then
          update public.remediation_attempts set state='ESCALATED',
            failure_classification='retry_exhausted',
            diagnostic='Configured remediation retry limit exhausted; human review required.',
            updated_at=now() where id=a.id;
        end if;
      else
        insert into public.remediation_attempts(remediation_id,attempt_number,state,patch_digest,base_sha,candidate_sha,verification_profile)
        values(r.id,r.attempt_count+1,'PATCH_GENERATED',p_command->>'patch_digest',p_command->>'base_sha',p_command->>'candidate_sha',p_command->>'verification_profile') returning * into a;
        r.current_attempt_id := a.id;
        r.attempt_count := r.attempt_count + 1;
        r.state := 'PATCH_GENERATED';
        r.failure_classification := null;
        r.diagnostic := null;
      end if;
    elsif p_command->>'action' = 'transition' then
      target_state := p_command->>'state';
      if r.state in ('PR_PUBLISHED','CANCELLED','ESCALATED','BLOCKED','VERIFICATION_INCOMPLETE') then raise exception 'terminal remediation'; end if;
      if not (target_state in ('CANCELLED','ESCALATED','BLOCKED') or
          (r.state = 'DISCOVERED' and target_state = 'TRIAGED') or
          (r.state = 'PATCH_GENERATED' and target_state = 'VERIFICATION_PENDING') or
          (r.state = 'VERIFICATION_PENDING' and target_state = 'VERIFYING') or
          (r.state = 'VERIFYING' and target_state in ('VERIFIED','VERIFICATION_FAILED','VERIFICATION_INCOMPLETE')) or
          (r.state = 'VERIFICATION_FAILED' and target_state = 'PATCH_REVISION') or
          (r.state = 'VERIFIED' and target_state = 'PR_PUBLISHED')) then raise exception 'invalid transition % -> %',r.state,target_state; end if;
      select * into a from public.remediation_attempts where id = r.current_attempt_id for update;
      if target_state = 'VERIFYING' then
        if coalesce(length(p_command->>'quincy_job_id'),0) = 0 then raise exception 'execution ID required'; end if;
        a.quincy_job_id := p_command->>'quincy_job_id';
        a.jenkins_build_id := p_command->>'jenkins_build_id';
      end if;
      if target_state in ('VERIFICATION_FAILED','VERIFICATION_INCOMPLETE','CANCELLED','ESCALATED','BLOCKED') then
        if coalesce(p_command->>'failure_classification','') not in ('security','build','test','timeout','cancelled','incomplete','infrastructure','policy','retry_exhausted','human') or coalesce(length(p_command->>'diagnostic'),0) = 0 then raise exception 'structured failure required'; end if;
        a.failure_classification := p_command->>'failure_classification';
        a.diagnostic := p_command->>'diagnostic';
        r.failure_classification := p_command->>'failure_classification';
        r.diagnostic := p_command->>'diagnostic';
      end if;
      if target_state = 'PATCH_REVISION' and r.attempt_count >= r.retry_limit+1 then
        target_state := 'ESCALATED';
        r.failure_classification := 'retry_exhausted';
        r.diagnostic := 'Configured remediation retry limit exhausted; human review required.';
        a.failure_classification := 'retry_exhausted';
        a.diagnostic := 'Configured remediation retry limit exhausted; human review required.';
      end if;
      if target_state = 'VERIFIED' then
        if a.quincy_job_id is null or p_command->>'quincy_job_id' is distinct from a.quincy_job_id then raise exception 'verification job mismatch'; end if;
        a.quincy_scan_execution_id := p_command->>'quincy_scan_execution_id';
        select * into v from public.remediation_security_verifications where id = (p_command->>'verification_id')::uuid;
        select * into b from public.quincy_scan_evidence where id = v.baseline_evidence_id;
        select * into c from public.quincy_scan_evidence where id = v.candidate_evidence_id;
        select * into f from public.findings where id = r.finding_id;
        if v.id is null or b.id is null or c.id is null or v.project_id <> r.project_id or b.project_id <> r.project_id or c.project_id <> r.project_id
          or v.final_decision is distinct from 'accepted' or v.comparison_outcome is distinct from 'not_detected' or v.scanner <> 'quincy'
          or v.verification_policy is distinct from 'bankai-complete-repository-differential-v1'
          or not exists(select 1 from public.tickets t where t.id = v.ticket_id and t.finding_id = r.finding_id and t.project_id = r.project_id)
          or v.commit_sha is distinct from a.candidate_sha or b.resolved_revision is distinct from a.base_sha or c.resolved_revision is distinct from a.candidate_sha
          or b.requested_revision is distinct from a.base_sha or c.requested_revision is distinct from a.candidate_sha
          or b.repository_id is distinct from r.repository_id or c.repository_id is distinct from r.repository_id
          or c.quincy_scan_execution_id is distinct from a.quincy_scan_execution_id
          or b.status <> 'complete' or c.status <> 'complete' or b.snapshot_id is null or c.snapshot_id is null or b.snapshot_id = c.snapshot_id
          or c.created_at < a.started_at or v.verified_at < a.started_at
          or v.decision_evidence_digest is distinct from c.evidence_digest then raise exception 'verification evidence missing, stale or mismatched'; end if;
        select count(*), (jsonb_agg(x))->0 into matches,comparison from jsonb_array_elements(c.comparisons) x
          where x->>'target_fingerprint' = f.legacy_fingerprint and (f.occurrence_id is null or x->>'target_occurrence_id' = f.occurrence_id);
        if matches <> 1 or comparison->>'outcome' is distinct from 'not_detected'
          or comparison->>'baseline_scan_execution_id' is distinct from b.quincy_scan_execution_id
          or comparison->>'candidate_scan_execution_id' is distinct from c.quincy_scan_execution_id
          or comparison->>'repository_id' is distinct from r.repository_id
          or comparison->>'baseline_snapshot_id' is distinct from b.snapshot_id or comparison->>'candidate_snapshot_id' is distinct from c.snapshot_id
          or comparison#>>'{baseline_revision,binding}' is distinct from 'quincy_verified_checkout'
          or comparison#>>'{candidate_revision,binding}' is distinct from 'quincy_verified_checkout'
          or comparison#>>'{baseline_revision,resolved_commit}' is distinct from a.base_sha
          or comparison#>>'{candidate_revision,resolved_commit}' is distinct from a.candidate_sha
          or comparison#>>'{compatibility,compatible}' is distinct from 'true'
          or comparison#>>'{integrity,baseline_evidence_digest}' is distinct from b.evidence_digest
          or comparison#>>'{evidence_references,baseline}' is distinct from b.evidence_digest
          or comparison#>>'{integrity,candidate_observation_digest}' is null
          or comparison#>>'{integrity,candidate_observation_digest}' is distinct from comparison#>>'{evidence_references,candidate_observation}'
          or coalesce((comparison->>'compared_at')::timestamptz,'-infinity'::timestamptz) < a.started_at then raise exception 'explicit comparison missing or mismatched'; end if;
        if jsonb_array_length(b.scanner_summaries) = 0 or jsonb_array_length(c.scanner_summaries) = 0
          or jsonb_array_length(b.observations) <> jsonb_array_length(b.scanner_summaries)
          or jsonb_array_length(c.observations) <> jsonb_array_length(c.scanner_summaries)
          or exists(select 1 from jsonb_array_elements(b.scanner_summaries || c.scanner_summaries) x where x->>'succeeded' is distinct from 'true')
          or exists(select 1 from jsonb_array_elements(b.observations || c.observations) x where x->>'status' is distinct from 'success'
            or x#>>'{termination,reason}' is distinct from 'completed'
            or x#>>'{completeness,discovery}' is distinct from 'complete' or x#>>'{completeness,analysis}' is distinct from 'complete' or x#>>'{completeness,findings}' is distinct from 'complete'
            or x#>>'{coverage,available}' is distinct from 'true' or x#>>'{coverage,ledger_complete}' is distinct from 'true' or x#>>'{coverage,truncated}' = 'true'
            or exists(select 1 from jsonb_array_elements(x->'errors') err where err->>'affects_completeness' is distinct from 'false')) then raise exception 'scan observations incomplete'; end if;
        if exists(select 1 from jsonb_array_elements(jsonb_build_array(comparison->'baseline_completeness',comparison->'candidate_completeness')) x where x->>'discovery' is distinct from 'complete' or x->>'analysis' is distinct from 'complete' or x->>'findings' is distinct from 'complete')
          or exists(select 1 from jsonb_array_elements(jsonb_build_array(comparison->'baseline_coverage',comparison->'candidate_coverage')) x where x->>'available' is distinct from 'true' or x->>'ledger_complete' is distinct from 'true' or x->>'truncated' = 'true')
          or not exists(select 1 from jsonb_array_elements(comparison#>'{candidate_coverage,entries}') x where x->>'path' = coalesce(comparison->>'target_file_path',f.file_path) and x->>'state' = 'analyzed' and x->>'result_source' = 'fresh') then raise exception 'fresh complete coverage required'; end if;
        a.verification_id := v.id; a.baseline_evidence_id := b.id; a.candidate_evidence_id := c.id;
      end if;
      r.state := target_state;
      -- A failed attempt retains its terminal outcome during revision/escalation.
      if a.id is not null and (old_state <> 'VERIFICATION_FAILED' or target_state = 'ESCALATED') then
        update public.remediation_attempts set state=r.state, quincy_job_id=a.quincy_job_id, quincy_scan_execution_id=a.quincy_scan_execution_id, jenkins_build_id=a.jenkins_build_id,
          verification_id=a.verification_id, baseline_evidence_id=a.baseline_evidence_id,candidate_evidence_id=a.candidate_evidence_id,
          failure_classification=a.failure_classification, diagnostic=a.diagnostic, updated_at=now() where id=a.id;
      end if;
    else raise exception 'unsupported command'; end if;
    update public.remediations set state=r.state,current_attempt_id=r.current_attempt_id,
      attempt_count=r.attempt_count,failure_classification=r.failure_classification,diagnostic=r.diagnostic,
      revision=revision+1,updated_at=now() where id=r.id returning * into r;
  end if;
  result := to_jsonb(r) - 'create_request' - 'create_key';
  insert into public.remediation_events(remediation_id,attempt_id,command_key,command,from_state,to_state,response)
  values(r.id,r.current_attempt_id,p_command->>'command_key',p_command,old_state,r.state,result);
  return result;
end $$;
revoke all on function public.remediation_command(jsonb) from public, anon, authenticated;
grant execute on function public.remediation_command(jsonb) to service_role;

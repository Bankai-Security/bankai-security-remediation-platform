-- Durable, service-only local runner control plane. This migration defines
-- storage and atomic transitions for the paired runner control plane. Task
-- claims stay feature-flagged and terminal results stay closed until artifact
-- byte verification and the signed isolated companion are available.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.local_runner_installations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  public_key text not null,
  token_digest text unique,
  token_expires_at timestamptz,
  protocol_version text not null check (protocol_version = '1'),
  capabilities jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(project_id, public_key)
);

create table if not exists public.local_runner_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  code_digest text not null unique check (code_digest ~ '^sha256-[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.local_runner_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  remediation_id uuid not null references public.remediations(id) on delete cascade,
  attempt_id uuid not null references public.remediation_attempts(id) on delete cascade,
  finding_id uuid not null references public.findings(id) on delete restrict,
  runner_id uuid references public.local_runner_installations(id) on delete set null,
  execution_id text not null unique,
  repository_id text not null,
  repository text not null,
  baseline_sha text not null check (baseline_sha ~ '^[0-9a-f]{40}$'),
  candidate_sha text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  profile text not null,
  policy_id text not null,
  state text not null default 'queued' check (state in ('queued', 'leased', 'running', 'cancelling', 'passed', 'failed', 'cancelled', 'incomplete', 'infrastructure_failure')),
  idempotency_key text not null unique,
  lease_id uuid,
  lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  last_sequence bigint not null default -1,
  last_event_digest text,
  cancel_requested_at timestamptz,
  result_digest text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(attempt_id)
);

create table if not exists public.local_runner_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.local_runner_tasks(id) on delete cascade,
  idempotency_key text not null,
  sequence bigint,
  event_type text not null check (event_type in ('claimed', 'heartbeat', 'progress', 'cancel_requested', 'result')),
  payload_digest text not null check (payload_digest ~ '^sha256-[0-9a-f]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique(task_id, idempotency_key),
  unique(task_id, sequence)
);

create table if not exists public.local_runner_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.local_runner_tasks(id) on delete cascade,
  name text not null check (name in ('build-log', 'test-report', 'scan-evidence')),
  storage_key text not null,
  size_bytes bigint not null check (size_bytes between 0 and 104857600),
  content_type text not null,
  digest text not null check (digest ~ '^sha256-[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique(task_id, name)
);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('local-runner-artifacts', 'local-runner-artifacts', false, 104857600,
  array['text/plain', 'application/json', 'application/xml', 'application/octet-stream'])
on conflict (id) do nothing;

create index if not exists local_runner_tasks_queue_idx on public.local_runner_tasks(created_at) where state = 'queued';
create index if not exists local_runner_tasks_lease_idx on public.local_runner_tasks(lease_expires_at) where state in ('leased', 'running', 'cancelling');
create index if not exists local_runner_installations_project_idx on public.local_runner_installations(project_id, status);

alter table public.local_runner_installations enable row level security;
alter table public.local_runner_pairing_codes enable row level security;
alter table public.local_runner_tasks enable row level security;
alter table public.local_runner_events enable row level security;
alter table public.local_runner_artifacts enable row level security;

create policy local_runner_installation_member_read on public.local_runner_installations for select
  using (public.project_role(project_id) is not null);
create policy local_runner_task_member_read on public.local_runner_tasks for select
  using (public.project_role(project_id) is not null);
create policy local_runner_event_member_read on public.local_runner_events for select
  using (exists (select 1 from public.local_runner_tasks t where t.id = task_id and public.project_role(t.project_id) is not null));
create policy local_runner_artifact_member_read on public.local_runner_artifacts for select
  using (exists (select 1 from public.local_runner_tasks t where t.id = task_id and public.project_role(t.project_id) is not null));

revoke all on public.local_runner_installations, public.local_runner_tasks, public.local_runner_events, public.local_runner_artifacts from public, anon, authenticated, service_role;
revoke all on public.local_runner_pairing_codes from public, anon, authenticated, service_role;
grant select (id, project_id, owner_id, public_key, protocol_version, capabilities, status, token_expires_at, last_seen_at, created_at, revoked_at) on public.local_runner_installations to authenticated;
grant select on public.local_runner_installations, public.local_runner_tasks, public.local_runner_events, public.local_runner_artifacts to service_role;
grant select on public.local_runner_tasks, public.local_runner_events, public.local_runner_artifacts to authenticated;
revoke all on sequence public.local_runner_events_id_seq from public, anon, authenticated, service_role;

-- Enqueue is idempotent by both execution and attempt. Task identity is copied
-- from persisted Bankai records, never accepted from a runner-supplied payload.
create or replace function public.enqueue_local_runner_task(p_task jsonb)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_attempt public.remediation_attempts%rowtype; v_remediation public.remediations%rowtype; v_row public.local_runner_tasks%rowtype;
begin
  select * into v_attempt from public.remediation_attempts where id = (p_task->>'attempt_id')::uuid for update;
  if not found then raise exception 'attempt not found'; end if;
  select * into v_remediation from public.remediations where id = v_attempt.remediation_id for update;
  if v_remediation.current_attempt_id <> v_attempt.id or v_remediation.state not in ('VERIFICATION_PENDING', 'VERIFYING') then raise exception 'attempt is not eligible'; end if;
  if v_attempt.base_sha <> p_task->>'baseline_sha' or v_attempt.candidate_sha <> p_task->>'candidate_sha' then raise exception 'attempt SHA mismatch'; end if;
  if v_remediation.project_id <> (p_task->>'project_id')::uuid or v_remediation.finding_id <> (p_task->>'finding_id')::uuid or v_remediation.repository_id <> p_task->>'repository_id' then raise exception 'attempt identity mismatch'; end if;
  insert into public.local_runner_tasks(project_id, remediation_id, attempt_id, finding_id, execution_id, repository_id, repository, baseline_sha, candidate_sha, profile, policy_id, idempotency_key)
  values (v_remediation.project_id, v_remediation.id, v_attempt.id, v_remediation.finding_id, p_task->>'execution_id', v_remediation.repository_id, p_task->>'repository', v_attempt.base_sha, v_attempt.candidate_sha, v_attempt.verification_profile, p_task->>'policy_id', p_task->>'idempotency_key')
  on conflict (attempt_id) do nothing returning * into v_row;
  if not found then
    select * into v_row from public.local_runner_tasks where attempt_id = v_attempt.id;
    if v_row.execution_id <> p_task->>'execution_id' or v_row.idempotency_key <> p_task->>'idempotency_key' then raise exception 'conflicting task replay'; end if;
  end if;
  return v_row;
end; $$;

create or replace function public.issue_local_runner_pairing_code(p_project_id uuid, p_owner_id uuid, p_code_digest text)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare v_expires timestamptz := now() + interval '10 minutes';
begin
  if not exists (select 1 from public.projects where id = p_project_id and owner_id = p_owner_id)
    and not exists (select 1 from public.project_members where project_id = p_project_id and user_id = p_owner_id and role in ('owner', 'admin', 'editor')) then
    raise exception 'project access denied';
  end if;
  insert into public.local_runner_pairing_codes(project_id, owner_id, code_digest, expires_at)
    values (p_project_id, p_owner_id, p_code_digest, v_expires);
  return v_expires;
end; $$;

create or replace function public.consume_local_runner_pairing_code(p_code_digest text, p_public_key text, p_capabilities jsonb, p_token_digest text, p_token_expires_at timestamptz)
returns public.local_runner_installations language plpgsql security definer set search_path = public, pg_temp as $$
declare v_code public.local_runner_pairing_codes%rowtype; v_runner public.local_runner_installations%rowtype;
begin
  select * into v_code from public.local_runner_pairing_codes where code_digest = p_code_digest and consumed_at is null and expires_at > now() for update;
  if not found then raise exception 'pairing code invalid or expired'; end if;
  update public.local_runner_pairing_codes set consumed_at = now() where id = v_code.id;
  if p_token_expires_at <= now() or p_token_expires_at > now() + interval '31 days' then raise exception 'runner token expiry invalid'; end if;
  insert into public.local_runner_installations(project_id, owner_id, public_key, token_digest, token_expires_at, protocol_version, capabilities)
    values (v_code.project_id, v_code.owner_id, p_public_key, p_token_digest, p_token_expires_at, '1', p_capabilities)
    on conflict (project_id, public_key) do update set token_digest = excluded.token_digest, token_expires_at = excluded.token_expires_at,
      protocol_version = excluded.protocol_version, capabilities = excluded.capabilities,
      status = 'active', revoked_at = null, last_seen_at = null
      where public.local_runner_installations.status = 'revoked'
    returning * into v_runner;
  if not found then raise exception 'runner key already enrolled'; end if;
  return v_runner;
end; $$;

create or replace function public.revoke_local_runner(p_project_id uuid, p_runner_id uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  update public.local_runner_installations set status = 'revoked', token_digest = null, token_expires_at = now(), revoked_at = now()
    where id = p_runner_id and project_id = p_project_id and status = 'active';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.update_local_runner_capabilities(p_runner_id uuid, p_capabilities jsonb)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_updated integer;
begin
  update public.local_runner_installations set capabilities = p_capabilities, last_seen_at = now()
    where id = p_runner_id and status = 'active';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end; $$;

create or replace function public.record_local_runner_artifact(p_runner_id uuid, p_lease_id uuid, p_execution_id text, p_name text, p_storage_key text, p_size_bytes bigint, p_content_type text, p_digest text)
returns public.local_runner_artifacts language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_row public.local_runner_artifacts%rowtype; v_existing public.local_runner_artifacts%rowtype;
begin
  select * into v_task from public.local_runner_tasks where runner_id = p_runner_id and lease_id = p_lease_id and execution_id = p_execution_id for update;
  if not found or v_task.state not in ('leased', 'running', 'cancelling') or v_task.lease_expires_at < now() then raise exception 'lease is not active'; end if;
  if p_name not in ('build-log', 'test-report', 'scan-evidence') or p_size_bytes < 0 or p_size_bytes > 104857600
    or p_digest !~ '^sha256-[0-9a-f]{64}$' then raise exception 'artifact descriptor invalid'; end if;
  select * into v_existing from public.local_runner_artifacts where task_id = v_task.id and name = p_name;
  if found then
    if v_existing.digest = p_digest and v_existing.size_bytes = p_size_bytes and v_existing.storage_key = p_storage_key then return v_existing; end if;
    raise exception 'conflicting artifact replay';
  end if;
  insert into public.local_runner_artifacts(task_id, name, storage_key, size_bytes, content_type, digest)
    values (v_task.id, p_name, p_storage_key, p_size_bytes, p_content_type, p_digest) returning * into v_row;
  return v_row;
end; $$;

-- Atomic claim: one active task per runner capacity slot; expired leases are
-- returned to the queue only when no result has been finalized.
create or replace function public.claim_local_runner_task(p_runner_id uuid, p_lease_seconds integer default 90)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_runner public.local_runner_installations%rowtype;
  v_active_count integer;
begin
  select * into v_runner from public.local_runner_installations where id = p_runner_id and status = 'active' for update;
  if not found then raise exception 'runner unavailable'; end if;
  if coalesce((v_runner.capabilities->>'docker_ready')::boolean, false) is not true
    or coalesce((v_runner.capabilities->>'jenkins_ready')::boolean, false) is not true then
    raise exception 'runner prerequisites are not ready';
  end if;
  select count(*) into v_active_count from public.local_runner_tasks where runner_id = p_runner_id and state in ('leased', 'running', 'cancelling') and lease_expires_at >= now();
  if v_active_count >= least(greatest(coalesce((v_runner.capabilities->>'max_concurrent_jobs')::integer, 1), 1), 4) then return null; end if;
  -- Never redispatch an expired lease automatically: the runner may already
  -- have submitted the execution to Jenkins. Fail closed and require explicit
  -- reconciliation/retry using a new attempt.
  update public.local_runner_tasks set state = 'incomplete', completed_at = now(), updated_at = now(),
    result = jsonb_build_object('reason', 'lease_expired', 'execution_id', execution_id)
    where state in ('leased', 'running') and lease_expires_at < now();
  select * into v_task from public.local_runner_tasks where project_id = v_runner.project_id and state = 'queued' order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.local_runner_tasks set runner_id = p_runner_id, lease_id = gen_random_uuid(), state = 'leased', lease_expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 300)), updated_at = now()
    where id = v_task.id returning * into v_task;
  update public.local_runner_installations set last_seen_at = now() where id = p_runner_id;
  return v_task;
end; $$;

create or replace function public.heartbeat_local_runner_task(p_runner_id uuid, p_lease_id uuid, p_execution_id text, p_heartbeat_id text, p_lease_seconds integer default 90)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_digest text;
begin
  select * into v_task from public.local_runner_tasks where runner_id = p_runner_id and lease_id = p_lease_id and execution_id = p_execution_id for update;
  if not found or v_task.state not in ('leased', 'running', 'cancelling') or v_task.lease_expires_at < now() then raise exception 'lease is not active'; end if;
  v_digest := 'sha256-' || encode(extensions.digest(convert_to(p_heartbeat_id, 'UTF8'), 'sha256'), 'hex');
  insert into public.local_runner_events(task_id, idempotency_key, event_type, payload_digest, payload) values (v_task.id, p_heartbeat_id, 'heartbeat', v_digest, jsonb_build_object('reported_at', now())) on conflict (task_id, idempotency_key) do nothing;
  update public.local_runner_tasks set last_heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 300)), state = case when state = 'leased' then 'running' else state end, updated_at = now() where id = v_task.id returning * into v_task;
  return v_task;
end; $$;

create or replace function public.record_local_runner_progress(p_runner_id uuid, p_lease_id uuid, p_progress jsonb, p_payload_digest text)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_seq bigint := (p_progress->>'sequence')::bigint; v_existing public.local_runner_events%rowtype;
begin
  select * into v_task from public.local_runner_tasks where runner_id = p_runner_id and lease_id = p_lease_id and execution_id = p_progress->>'execution_id' for update;
  if not found or v_task.state not in ('leased', 'running') or v_task.lease_expires_at < now() then raise exception 'lease is not active'; end if;
  if v_seq = v_task.last_sequence then
    select * into v_existing from public.local_runner_events where task_id = v_task.id and sequence = v_seq;
    if found and v_existing.payload_digest = p_payload_digest then return v_task; end if;
    raise exception 'conflicting progress replay';
  end if;
  if v_seq <> v_task.last_sequence + 1 then raise exception 'progress sequence gap'; end if;
  insert into public.local_runner_events(task_id, idempotency_key, sequence, event_type, payload_digest, payload) values (v_task.id, p_progress->>'idempotency_key', v_seq, 'progress', p_payload_digest, p_progress);
  update public.local_runner_tasks set last_sequence = v_seq, last_event_digest = p_payload_digest, state = 'running', last_heartbeat_at = now(), updated_at = now() where id = v_task.id returning * into v_task;
  return v_task;
end; $$;

create or replace function public.request_local_runner_cancel(p_task_id uuid)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype;
begin
  update public.local_runner_tasks set state = case when state = 'queued' then 'cancelled' else 'cancelling' end,
    completed_at = case when state = 'queued' then now() else completed_at end,
    cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
    where id = p_task_id and state in ('queued', 'leased', 'running') returning * into v_task;
  if not found then select * into v_task from public.local_runner_tasks where id = p_task_id; end if;
  if not found then raise exception 'task not found'; end if;
  insert into public.local_runner_events(task_id, idempotency_key, event_type, payload_digest, payload)
    values (v_task.id, 'cancel:' || v_task.id::text, 'cancel_requested',
      'sha256-' || encode(extensions.digest(convert_to(v_task.id::text, 'UTF8'), 'sha256'), 'hex'),
      jsonb_build_object('state', v_task.state, 'requested_at', now()))
    on conflict (task_id, idempotency_key) do nothing;
  return v_task;
end; $$;

create or replace function public.finalize_local_runner_task(p_runner_id uuid, p_lease_id uuid, p_result jsonb, p_payload_digest text)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_state text;
begin
  select * into v_task from public.local_runner_tasks where runner_id = p_runner_id and lease_id = p_lease_id and execution_id = p_result->>'execution_id' and attempt_id = (p_result->>'attempt_id')::uuid for update;
  if not found then raise exception 'result identity mismatch'; end if;
  if v_task.result is not null then
    if v_task.result_digest = p_payload_digest then return v_task; end if;
    raise exception 'conflicting terminal result';
  end if;
  if v_task.state not in ('leased', 'running', 'cancelling') then raise exception 'task is not finalizable'; end if;
  v_state := p_result->>'outcome';
  update public.local_runner_tasks set state = v_state, result = p_result, result_digest = p_payload_digest, completed_at = now(), updated_at = now() where id = v_task.id returning * into v_task;
  insert into public.local_runner_events(task_id, idempotency_key, event_type, payload_digest, payload) values (v_task.id, p_result->>'idempotency_key', 'result', p_payload_digest, p_result);
  return v_task;
end; $$;

revoke all on function public.enqueue_local_runner_task(jsonb), public.issue_local_runner_pairing_code(uuid, uuid, text), public.consume_local_runner_pairing_code(text, text, jsonb, text, timestamptz), public.revoke_local_runner(uuid, uuid), public.update_local_runner_capabilities(uuid, jsonb), public.record_local_runner_artifact(uuid, uuid, text, text, text, bigint, text, text), public.claim_local_runner_task(uuid, integer), public.heartbeat_local_runner_task(uuid, uuid, text, text, integer), public.record_local_runner_progress(uuid, uuid, jsonb, text), public.request_local_runner_cancel(uuid), public.finalize_local_runner_task(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.enqueue_local_runner_task(jsonb), public.issue_local_runner_pairing_code(uuid, uuid, text), public.consume_local_runner_pairing_code(text, text, jsonb, text, timestamptz), public.revoke_local_runner(uuid, uuid), public.update_local_runner_capabilities(uuid, jsonb), public.record_local_runner_artifact(uuid, uuid, text, text, text, bigint, text, text), public.claim_local_runner_task(uuid, integer), public.heartbeat_local_runner_task(uuid, uuid, text, text, integer), public.record_local_runner_progress(uuid, uuid, jsonb, text), public.request_local_runner_cancel(uuid), public.finalize_local_runner_task(uuid, uuid, jsonb, text) to service_role;

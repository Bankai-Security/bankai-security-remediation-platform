-- Prevent leases until all local execution dependencies are healthy and make
-- the provider enqueue adapter persist the server-derived target identity.
create or replace function public.enqueue_local_runner_task(p_task jsonb)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_attempt public.remediation_attempts%rowtype;
  v_remediation public.remediations%rowtype;
  v_finding public.findings%rowtype;
  v_row public.local_runner_tasks%rowtype;
  v_target jsonb;
begin
  select * into v_attempt from public.remediation_attempts where id = (p_task->>'attempt_id')::uuid for update;
  if not found then raise exception 'attempt not found'; end if;
  select * into v_remediation from public.remediations where id = v_attempt.remediation_id for update;
  if v_remediation.current_attempt_id <> v_attempt.id or v_remediation.state not in ('VERIFICATION_PENDING','VERIFYING') then raise exception 'attempt is not eligible'; end if;
  if v_attempt.base_sha <> p_task->>'baseline_sha' or v_attempt.candidate_sha <> p_task->>'candidate_sha' then raise exception 'attempt SHA mismatch'; end if;
  if v_remediation.project_id <> (p_task->>'project_id')::uuid or v_remediation.finding_id <> (p_task->>'finding_id')::uuid or v_remediation.repository_id <> p_task->>'repository_id' then raise exception 'attempt identity mismatch'; end if;
  select * into v_finding from public.findings where id = v_remediation.finding_id and project_id = v_remediation.project_id;
  if not found or v_finding.legacy_fingerprint is null then raise exception 'finding comparison identity unavailable'; end if;
  v_target := jsonb_build_object('legacy_fingerprint',v_finding.legacy_fingerprint,'occurrence_id',v_finding.occurrence_id,
    'external_id',v_finding.external_id,'file_path',v_finding.file_path);
  insert into public.local_runner_tasks(project_id, remediation_id, attempt_id, finding_id, execution_id,
      repository_id, repository, baseline_sha, candidate_sha, profile, policy_id, idempotency_key, target)
    values (v_remediation.project_id, v_remediation.id, v_attempt.id, v_remediation.finding_id,
      p_task->>'execution_id', v_remediation.repository_id, p_task->>'repository', v_attempt.base_sha,
      v_attempt.candidate_sha, v_attempt.verification_profile, p_task->>'policy_id', p_task->>'idempotency_key', v_target)
    on conflict (attempt_id) do nothing returning * into v_row;
  if not found then
    select * into v_row from public.local_runner_tasks where attempt_id = v_attempt.id;
    if v_row.execution_id <> p_task->>'execution_id' or v_row.idempotency_key <> p_task->>'idempotency_key'
      or v_row.target <> v_target then raise exception 'conflicting task replay'; end if;
  end if;
  return v_row;
end; $$;
revoke all on function public.enqueue_local_runner_task(jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_local_runner_task(jsonb) to service_role;

create or replace function public.claim_local_runner_task(p_runner_id uuid, p_lease_seconds integer default 90)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_runner public.local_runner_installations%rowtype; v_active_count integer;
begin
  select * into v_runner from public.local_runner_installations where id = p_runner_id and status = 'active' for update;
  if not found then raise exception 'runner unavailable'; end if;
  if v_runner.token_expires_at <= now() then raise exception 'runner credential expired'; end if;
  if coalesce((v_runner.capabilities->>'docker_ready')::boolean, false) is not true
    or coalesce((v_runner.capabilities->>'jenkins_ready')::boolean, false) is not true
    or coalesce((v_runner.capabilities->>'quincy_ready')::boolean, false) is not true then raise exception 'runner prerequisites are not ready'; end if;
  select count(*) into v_active_count from public.local_runner_tasks
    where runner_id = p_runner_id and state in ('leased','running','cancelling') and lease_expires_at >= now();
  if v_active_count >= least(greatest(coalesce((v_runner.capabilities->>'max_concurrent_jobs')::integer,1),1),4) then return null; end if;
  perform public.expire_local_runner_leases();
  select * into v_task from public.local_runner_tasks where project_id = v_runner.project_id and state = 'queued'
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.local_runner_tasks set runner_id = p_runner_id, lease_id = gen_random_uuid(), state = 'leased',
    lease_expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds,30),300)), updated_at = now()
    where id = v_task.id returning * into v_task;
  update public.local_runner_installations set last_seen_at = now() where id = p_runner_id;
  return v_task;
end; $$;
revoke all on function public.claim_local_runner_task(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_local_runner_task(uuid, integer) to service_role;

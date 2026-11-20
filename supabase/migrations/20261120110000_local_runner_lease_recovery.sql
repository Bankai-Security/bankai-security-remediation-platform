-- Expire abandoned local-runner leases and fail the matching remediation
-- attempt closed in the same transaction. Never requeue an execution whose
-- Jenkins submission may have succeeded before the runner disappeared.
create or replace function public.expire_local_runner_leases()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_remediation public.remediations%rowtype; v_count integer := 0;
begin
  for v_task in
    select * from public.local_runner_tasks
      where state in ('leased', 'running', 'cancelling') and lease_expires_at < now()
      order by lease_expires_at for update skip locked
  loop
    update public.local_runner_tasks set state = 'incomplete', completed_at = now(), updated_at = now(),
      result = jsonb_build_object('reason', 'lease_expired', 'execution_id', execution_id)
      where id = v_task.id;
    select * into v_remediation from public.remediations where id = v_task.remediation_id for update;
    if v_remediation.current_attempt_id = v_task.attempt_id and v_remediation.state in ('VERIFICATION_PENDING', 'VERIFYING') then
      perform public.remediation_command(jsonb_build_object(
        'schema_version', '1.0', 'action', 'transition',
        'command_key', 'local-runner-expired:' || v_task.attempt_id::text,
        'remediation_id', v_remediation.id, 'expected_revision', v_remediation.revision,
        'state', 'VERIFICATION_INCOMPLETE', 'failure_classification', 'incomplete',
        'diagnostic', 'Local runner lease expired before a terminal result was persisted; no pass was recorded.'
      ));
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end; $$;

create or replace function public.claim_local_runner_task(p_runner_id uuid, p_lease_seconds integer default 90)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_runner public.local_runner_installations%rowtype; v_active_count integer;
begin
  select * into v_runner from public.local_runner_installations where id = p_runner_id and status = 'active' for update;
  if not found then raise exception 'runner unavailable'; end if;
  if v_runner.token_expires_at <= now() then raise exception 'runner credential expired'; end if;
  if coalesce((v_runner.capabilities->>'docker_ready')::boolean, false) is not true
    or coalesce((v_runner.capabilities->>'jenkins_ready')::boolean, false) is not true then
    raise exception 'runner prerequisites are not ready';
  end if;
  select count(*) into v_active_count from public.local_runner_tasks
    where runner_id = p_runner_id and state in ('leased', 'running', 'cancelling') and lease_expires_at >= now();
  if v_active_count >= least(greatest(coalesce((v_runner.capabilities->>'max_concurrent_jobs')::integer, 1), 1), 4) then return null; end if;
  perform public.expire_local_runner_leases();
  select * into v_task from public.local_runner_tasks where project_id = v_runner.project_id and state = 'queued'
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.local_runner_tasks set runner_id = p_runner_id, lease_id = gen_random_uuid(), state = 'leased',
    lease_expires_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 300)), updated_at = now()
    where id = v_task.id returning * into v_task;
  update public.local_runner_installations set last_seen_at = now() where id = p_runner_id;
  return v_task;
end; $$;

revoke all on function public.expire_local_runner_leases(), public.claim_local_runner_task(uuid, integer) from public, anon, authenticated;
grant execute on function public.expire_local_runner_leases(), public.claim_local_runner_task(uuid, integer) to service_role;

-- A late terminal callback must not win the race against lease expiry. An
-- identical replay of an already committed result remains idempotent.
create or replace function public.finalize_local_runner_task(p_runner_id uuid, p_lease_id uuid, p_result jsonb, p_payload_digest text)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_state text;
begin
  select * into v_task from public.local_runner_tasks
    where runner_id = p_runner_id and lease_id = p_lease_id
      and execution_id = p_result->>'execution_id' and attempt_id = (p_result->>'attempt_id')::uuid for update;
  if not found then raise exception 'result identity mismatch'; end if;
  if v_task.result is not null then
    if v_task.result_digest = p_payload_digest then return v_task; end if;
    raise exception 'conflicting terminal result';
  end if;
  if v_task.state not in ('leased','running','cancelling') or v_task.lease_expires_at is null or v_task.lease_expires_at < now() then raise exception 'task lease is not active'; end if;
  v_state := p_result->>'outcome';
  update public.local_runner_tasks set state = v_state, result = p_result, result_digest = p_payload_digest,
    completed_at = now(), updated_at = now() where id = v_task.id returning * into v_task;
  insert into public.local_runner_events(task_id, idempotency_key, event_type, payload_digest, payload)
    values (v_task.id, p_result->>'idempotency_key', 'result', p_payload_digest, p_result);
  return v_task;
end; $$;
revoke all on function public.finalize_local_runner_task(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.finalize_local_runner_task(uuid, uuid, jsonb, text) to service_role;

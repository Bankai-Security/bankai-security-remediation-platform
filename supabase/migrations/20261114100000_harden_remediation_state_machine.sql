-- SCRUM-30 follow-up: safe for databases where the initial state-machine
-- migration has already run. Keep the original RPC as the authoritative
-- transition engine, then normalize response revision/diagnosis atomically.
alter table public.remediations
  add column if not exists failure_classification text,
  add column if not exists diagnostic text;

alter function public.remediation_command(jsonb)
  rename to remediation_command_v1_transition_engine;

create function public.remediation_command(p_command jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  result jsonb;
  v_remediation_id uuid;
  v_command_key text;
  action text;
  v_state text;
  v_failure_classification text;
  v_diagnostic text;
  v_attempt_id uuid;
  parent_failure text;
  parent_diagnostic text;
begin
  result := public.remediation_command_v1_transition_engine(p_command);
  v_remediation_id := (result->>'id')::uuid;
  v_command_key := p_command->>'command_key';
  action := p_command->>'action';
  v_state := result->>'state';
  v_attempt_id := nullif(result->>'current_attempt_id','')::uuid;

  -- The initial RPC persisted a create event before its caller could obtain a
  -- usable revision. Upgrade old revision-zero responses once, idempotently.
  if action = 'create' and (result->>'revision')::integer = 0 then
    update public.remediations set revision=1,updated_at=now() where id=v_remediation_id;
    result := result || jsonb_build_object('revision',1);
  end if;

  v_failure_classification := p_command->>'failure_classification';
  v_diagnostic := p_command->>'diagnostic';
  if action = 'start_attempt' and v_state = 'PATCH_GENERATED' then
    v_failure_classification := null;
    v_diagnostic := null;
  elsif v_state = 'ESCALATED' and coalesce(v_failure_classification,'') = '' then
    v_failure_classification := 'retry_exhausted';
    v_diagnostic := 'Configured remediation retry limit exhausted; human review required.';
  end if;

  if v_state in ('VERIFICATION_FAILED','VERIFICATION_INCOMPLETE','CANCELLED','ESCALATED','BLOCKED')
     or (action = 'start_attempt' and v_state = 'PATCH_GENERATED') then
    update public.remediations set failure_classification=v_failure_classification,
      diagnostic=v_diagnostic,updated_at=now() where id=v_remediation_id;
    if v_attempt_id is not null and v_state in ('VERIFICATION_FAILED','VERIFICATION_INCOMPLETE','CANCELLED','ESCALATED','BLOCKED') then
      update public.remediation_attempts set state=v_state,
        failure_classification=v_failure_classification,diagnostic=v_diagnostic,updated_at=now()
        where id=v_attempt_id;
    end if;
  end if;

  select r.failure_classification,r.diagnostic into parent_failure,parent_diagnostic
    from public.remediations r where r.id=v_remediation_id;
  result := result || jsonb_build_object(
    'failure_classification',parent_failure,'diagnostic',parent_diagnostic
  );
  update public.remediation_events set response=result
    where remediation_events.remediation_id=v_remediation_id
      and remediation_events.command_key=v_command_key;
  return result;
end $$;

revoke all on function public.remediation_command_v1_transition_engine(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.remediation_command(jsonb) from public, anon, authenticated;
grant execute on function public.remediation_command(jsonb) to service_role;

-- Retire the superseded Quincy, CI pipeline, and local runner application paths.
-- Keep old remediation, verification, pipeline, and runner rows as audit history.

drop trigger if exists enforce_ticket_completion_gate on public.tickets;
drop function if exists public.enforce_ticket_completion_gate();

create or replace function public.enforce_ticket_completion_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'Done' and new.github_pr_state <> 'merged' then
    new.status := case when new.github_pr_number is not null then 'In Review' else 'In Progress' end;
  end if;
  return new;
end;
$$;

create trigger enforce_ticket_completion_gate
  before insert or update of status, github_pr_number, github_pr_state
  on public.tickets for each row execute function public.enforce_ticket_completion_gate();

comment on function public.enforce_ticket_completion_gate() is
  'Allows Done only after a remediation pull request is merged.';

-- Remove the callable Quincy verification and local-runner paths while keeping
-- their rows and storage available for historical audit/export.
drop trigger if exists remediation_attempt_verified_manifest on public.remediation_attempts;
drop function if exists public.require_remediation_verification_manifest();
drop function if exists public.quincy_repository_identity(text);
drop function if exists public.remediation_command(jsonb);
drop function if exists public.request_local_verification(jsonb);
drop function if exists public.expire_local_runner_leases();
drop function if exists public.enqueue_local_runner_task(jsonb);
drop function if exists public.issue_local_runner_pairing_code(uuid, uuid, text);
drop function if exists public.consume_local_runner_pairing_code(text, text, jsonb, text, timestamptz);
drop function if exists public.revoke_local_runner(uuid, uuid);
drop function if exists public.update_local_runner_capabilities(uuid, jsonb);
drop function if exists public.record_local_runner_artifact(uuid, uuid, text, text, text, bigint, text, text);
drop function if exists public.claim_local_runner_task(uuid, integer);
drop function if exists public.heartbeat_local_runner_task(uuid, uuid, text, text, integer);
drop function if exists public.record_local_runner_progress(uuid, uuid, jsonb, text);
drop function if exists public.request_local_runner_cancel(uuid);
drop function if exists public.finalize_local_runner_task(uuid, uuid, jsonb, text);

-- Historical runner tables, verification evidence, pipeline runs, and legacy
-- CI columns remain available as audit history. No application route or worker
-- writes to these records after this release.

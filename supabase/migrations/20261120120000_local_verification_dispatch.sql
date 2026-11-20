-- Persist explicit per-attempt run/skip choice and bind the local Quincy
-- request to the finding identity selected by Bankai.
alter table public.local_runner_tasks add column if not exists target jsonb not null default '{}'::jsonb;

create table if not exists public.local_verification_choices (
  attempt_id uuid primary key references public.remediation_attempts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  remediation_id uuid not null references public.remediations(id) on delete cascade,
  choice text not null check (choice in ('run', 'skip')),
  selected_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.local_verification_choices enable row level security;
revoke all on public.local_verification_choices from public, anon, authenticated, service_role;
grant select on public.local_verification_choices to authenticated, service_role;
create policy local_verification_choice_member_read on public.local_verification_choices for select
  using (public.project_role(project_id) is not null);

create or replace function public.request_local_verification(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_remediation public.remediations%rowtype;
  v_attempt public.remediation_attempts%rowtype;
  v_finding public.findings%rowtype;
  v_choice text := p_request->>'choice';
  v_selected_by uuid := (p_request->>'selected_by')::uuid;
  v_task public.local_runner_tasks%rowtype;
  v_existing_task public.local_runner_tasks%rowtype;
  v_policy text := 'bankai-complete-repository-differential-v1';
  v_target jsonb;
begin
  select * into v_remediation from public.remediations
    where id = (p_request->>'remediation_id')::uuid and project_id = (p_request->>'project_id')::uuid for update;
  if not found or v_remediation.current_attempt_id is null then raise exception 'current remediation attempt not found'; end if;
  select * into v_attempt from public.remediation_attempts where id = v_remediation.current_attempt_id for update;
  select * into v_finding from public.findings where id = v_remediation.finding_id and project_id = v_remediation.project_id;
  if not found or v_finding.legacy_fingerprint is null then raise exception 'finding comparison identity unavailable'; end if;
  if v_choice not in ('run', 'skip') then raise exception 'choice must be run or skip'; end if;
  if v_remediation.state not in ('PATCH_GENERATED', 'VERIFICATION_PENDING') then raise exception 'remediation is not eligible for local verification'; end if;
  v_target := jsonb_build_object('legacy_fingerprint',v_finding.legacy_fingerprint,'occurrence_id',v_finding.occurrence_id,
    'external_id',v_finding.external_id,'file_path',v_finding.file_path);
  select * into v_existing_task from public.local_runner_tasks where attempt_id = v_attempt.id for update;
  if found and v_existing_task.state not in ('queued') then raise exception 'local verification task has already started or finished'; end if;
  insert into public.local_verification_choices(attempt_id, project_id, remediation_id, choice, selected_by)
    values (v_attempt.id, v_remediation.project_id, v_remediation.id, v_choice, v_selected_by)
    on conflict (attempt_id) do update set choice = excluded.choice, selected_by = excluded.selected_by, updated_at = now();
  if v_choice = 'skip' then
    if v_existing_task.id is not null then
      update public.local_runner_tasks set state = 'cancelled', completed_at = now(), updated_at = now(),
        result = jsonb_build_object('reason','user_skipped_before_claim') where id = v_existing_task.id;
    end if;
    return jsonb_build_object('choice','skip','attempt_id',v_attempt.id,'task',null);
  end if;
  if v_remediation.state = 'PATCH_GENERATED' then
    perform public.remediation_command(jsonb_build_object('schema_version','1.0','action','transition',
      'command_key','local-choice:' || v_attempt.id::text || ':pending', 'remediation_id',v_remediation.id,
      'expected_revision',v_remediation.revision,'state','VERIFICATION_PENDING'));
  end if;
  insert into public.local_runner_tasks(project_id, remediation_id, attempt_id, finding_id, execution_id,
      repository_id, repository, baseline_sha, candidate_sha, profile, policy_id, idempotency_key, target)
    values (v_remediation.project_id, v_remediation.id, v_attempt.id, v_remediation.finding_id,
      p_request->>'execution_id', v_remediation.repository_id, p_request->>'repository', v_attempt.base_sha,
      v_attempt.candidate_sha, v_attempt.verification_profile, v_policy,
      'local-attempt:' || v_attempt.id::text, v_target)
    on conflict (attempt_id) do nothing returning * into v_task;
  if not found then
    select * into v_task from public.local_runner_tasks where attempt_id = v_attempt.id;
    if v_task.target <> v_target or v_task.remediation_id <> v_remediation.id
      or v_task.baseline_sha <> v_attempt.base_sha or v_task.candidate_sha <> v_attempt.candidate_sha then
      raise exception 'conflicting local verification task replay';
    end if;
  end if;
  return jsonb_build_object('choice','run','attempt_id',v_attempt.id,'task',to_jsonb(v_task));
end; $$;

revoke all on function public.request_local_verification(jsonb) from public, anon, authenticated;
grant execute on function public.request_local_verification(jsonb) to service_role;

create or replace function public.claim_local_runner_task(p_runner_id uuid, p_lease_seconds integer default 90)
returns public.local_runner_tasks language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.local_runner_tasks%rowtype; v_runner public.local_runner_installations%rowtype; v_active_count integer;
begin
  select * into v_runner from public.local_runner_installations where id = p_runner_id and status = 'active' for update;
  if not found then raise exception 'runner unavailable'; end if;
  if v_runner.token_expires_at <= now() then raise exception 'runner credential expired'; end if;
  if coalesce((v_runner.capabilities->>'docker_ready')::boolean, false) is not true
    or coalesce((v_runner.capabilities->>'jenkins_ready')::boolean, false) is not true then raise exception 'runner prerequisites are not ready'; end if;
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

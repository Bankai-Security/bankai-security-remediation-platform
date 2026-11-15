-- SCRUM-30 disposable Supabase/PostgreSQL regression. Requires the full
-- migration chain. It creates a synthetic project/finding only when the
-- database has no findings; all fixture and workflow data is rolled back.
begin;
do $fixture$
declare
  u uuid := gen_random_uuid();
  p uuid;
  s uuid;
begin
  if exists (select 1 from public.findings where legacy_fingerprint = 'scrum30-fixture-legacy') then
    return;
  end if;

  insert into auth.users (
    id, aud, role, email, encrypted_password,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    u, 'authenticated', 'authenticated', 'scrum30-' || u::text || '@example.invalid', '',
    '{}'::jsonb, '{}'::jsonb, now(), now()
  );
  insert into public.projects (owner_id, name)
    values (u, 'SCRUM-30 disposable test fixture') returning id into p;
  insert into public.scans (project_id, filename)
    values (p, 'scrum30-fixture.csv') returning id into s;
  insert into public.findings (
    project_id, scan_id, fingerprint, title, severity, legacy_fingerprint, file_path
  ) values (
    p, s, 'scrum30-fixture-fingerprint', 'SCRUM-30 fixture finding', 'High',
    'scrum30-fixture-legacy', 'src/fixture.js'
  );
end $fixture$;

do $$
declare
  p uuid;
  f uuid;
  r jsonb;
  replay jsonb;
  rem uuid;
  rev integer;
  attempt_id uuid;
  attempt2_id uuid;
  a public.remediation_attempts%rowtype;
  attempt_total integer;
  cmd jsonb;
begin
  select project_id, id into p, f from public.findings
    where legacy_fingerprint = 'scrum30-fixture-legacy' order by created_at limit 1;
  if p is null or f is null then
    raise exception 'SCRUM-30 test requires one existing project/finding fixture';
  end if;

  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-create',
    'action','create','project_id',p,'finding_id',f,'repository_id','fixture-repository','retry_limit',1);
  r := public.remediation_command(cmd);
  replay := public.remediation_command(cmd);
  if r->>'id' is distinct from replay->>'id' or (r->>'revision')::integer <> 1 then
    raise exception 'create idempotency/revision initialization failed';
  end if;
  rem := (r->>'id')::uuid;
  rev := (r->>'revision')::integer;

  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-triage',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','TRIAGED');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;

  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-attempt',
    'action','start_attempt','remediation_id',rem,'expected_revision',rev,
    'patch_digest','sha256-' || repeat('a',64),'base_sha',repeat('b',40),
    'candidate_sha',repeat('c',40),'verification_profile','scrum30-test-v1');
  r := public.remediation_command(cmd);
  replay := public.remediation_command(cmd);
  if r->>'current_attempt_id' is distinct from replay->>'current_attempt_id' then
    raise exception 'duplicate attempt delivery created a different attempt';
  end if;
  attempt_id := (r->>'current_attempt_id')::uuid; rev := (r->>'revision')::integer;

  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-pending',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFICATION_PENDING');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-running',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFYING','quincy_job_id','execution-test');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  begin
    perform public.remediation_command(jsonb_build_object('schema_version','1.0','command_key','scrum30-test-false-verified',
      'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFIED',
      'quincy_job_id','execution-test','quincy_scan_execution_id','scan-test',
      'verification_id','00000000-0000-4000-8000-00000000ffff'));
    raise exception 'unbacked verification was accepted';
  exception when others then
    if sqlerrm = 'unbacked verification was accepted' then raise; end if;
  end;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-failed',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFICATION_FAILED',
    'failure_classification','security','diagnostic','fixture finding remains');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-exhausted',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','PATCH_REVISION');
  r := public.remediation_command(cmd);
  if r->>'state' is distinct from 'PATCH_REVISION' then
    raise exception 'first failure should permit one bounded retry';
  end if;
  rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-attempt-2',
    'action','start_attempt','remediation_id',rem,'expected_revision',rev,
    'patch_digest','sha256-' || repeat('d',64),'base_sha',repeat('c',40),
    'candidate_sha',repeat('e',40),'verification_profile','scrum30-test-v1');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  attempt2_id := (r->>'current_attempt_id')::uuid;
  if r->>'failure_classification' is not null or r->>'diagnostic' is not null then
    raise exception 'new attempt inherited previous parent failure diagnosis';
  end if;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-pending-2',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFICATION_PENDING');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-running-2',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFYING','quincy_job_id','execution-test-2');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-failed-2',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','VERIFICATION_FAILED',
    'failure_classification','security','diagnostic','fixture finding remains');
  r := public.remediation_command(cmd); rev := (r->>'revision')::integer;
  cmd := jsonb_build_object('schema_version','1.0','command_key','scrum30-test-exhausted-2',
    'action','transition','remediation_id',rem,'expected_revision',rev,'state','PATCH_REVISION');
  r := public.remediation_command(cmd);
  if r->>'state' is distinct from 'ESCALATED' then
    raise exception 'retry exhaustion did not escalate';
  end if;
  if r->>'failure_classification' is distinct from 'retry_exhausted'
     or r->>'diagnostic' is null then
    raise exception 'terminal remediation did not retain exhaustion diagnosis';
  end if;
  select * into strict a from public.remediation_attempts where id = attempt2_id;
  if a.state is distinct from 'ESCALATED'
     or a.failure_classification is distinct from 'retry_exhausted'
     or a.diagnostic is null then
    raise exception 'retry exhaustion was not retained on the attempt';
  end if;
  select count(*) into attempt_total from public.remediation_attempts where remediation_id = rem;
  if attempt_total <> 2 then raise exception 'expected two independently retained attempts'; end if;
  select * into strict a from public.remediation_attempts where id = attempt_id;
  if a.state is distinct from 'VERIFICATION_FAILED' then
    raise exception 'prior failed attempt history was overwritten';
  end if;
  raise notice 'SCRUM-30 state-machine assertions passed';
end $$;

-- A second remediation proves the positive evidence gate and that mismatched
-- execution identity is rejected even when an accepted decision exists.
do $$
declare
  p uuid;
  f uuid;
  ticket uuid;
  remediation_id uuid;
  attempt_id uuid;
  baseline_id uuid;
  candidate_id uuid;
  verification_id uuid;
  revision integer;
  result jsonb;
  base_sha text := repeat('1', 40);
  candidate_sha text := repeat('2', 40);
  baseline_digest text := 'sha256-' || repeat('3', 64);
  candidate_digest text := 'sha256-' || repeat('4', 64);
  baseline_snapshot text := 'snapshot-scrum30-baseline';
  candidate_snapshot text := 'snapshot-scrum30-candidate';
  baseline_execution text := 'scrum30-positive-baseline';
  candidate_execution text := 'scrum30-positive-candidate';
  target_comparison jsonb;
  observation jsonb;
begin
  select project_id, id into strict p, f from public.findings
    where legacy_fingerprint = 'scrum30-fixture-legacy';
  insert into public.tickets(project_id,finding_id,key,title,severity,status)
    values(p,f,'SCRUM30-POSITIVE','SCRUM-30 positive evidence fixture','High','In Progress')
    returning id into ticket;

  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-create','action','create','project_id',p,
    'finding_id',f,'repository_id','fixture-repository','retry_limit',1));
  remediation_id := (result->>'id')::uuid;
  revision := (result->>'revision')::integer;
  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-triage','action','transition',
    'remediation_id',remediation_id,'expected_revision',revision,'state','TRIAGED'));
  revision := (result->>'revision')::integer;
  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-attempt','action','start_attempt',
    'remediation_id',remediation_id,'expected_revision',revision,
    'patch_digest','sha256-' || repeat('5',64),'base_sha',base_sha,
    'candidate_sha',candidate_sha,'verification_profile','scrum30-test-v1'));
  attempt_id := (result->>'current_attempt_id')::uuid;
  revision := (result->>'revision')::integer;
  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-pending','action','transition',
    'remediation_id',remediation_id,'expected_revision',revision,
    'state','VERIFICATION_PENDING'));
  revision := (result->>'revision')::integer;
  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-running','action','transition',
    'remediation_id',remediation_id,'expected_revision',revision,
    'state','VERIFYING','quincy_job_id','scrum30-positive-job'));
  revision := (result->>'revision')::integer;

  observation := jsonb_build_object(
    'status','success','termination',jsonb_build_object('reason','completed'),
    'completeness',jsonb_build_object('discovery','complete','analysis','complete','findings','complete'),
    'coverage',jsonb_build_object('available',true,'ledger_complete',true,'truncated',false),
    'errors','[]'::jsonb);
  insert into public.quincy_scan_evidence(project_id,quincy_scan_execution_id,
    repository_id,requested_revision,resolved_revision,snapshot_id,status,
    scanner_summaries,observations,evidence_digest)
  values(p,baseline_execution,'fixture-repository',base_sha,base_sha,
    baseline_snapshot,'complete',jsonb_build_array(jsonb_build_object('scanner','schrift','succeeded',true)),
    jsonb_build_array(observation),baseline_digest) returning id into baseline_id;

  target_comparison := jsonb_build_object(
    'target_fingerprint','scrum30-fixture-legacy','target_occurrence_id','scrum30-fixture-occurrence',
    'target_file_path','src/fixture.js','outcome','not_detected',
    'baseline_scan_execution_id',baseline_execution,
    'candidate_scan_execution_id',candidate_execution,'repository_id','fixture-repository',
    'baseline_snapshot_id',baseline_snapshot,'candidate_snapshot_id',candidate_snapshot,
    'baseline_revision',jsonb_build_object('binding','quincy_verified_checkout','resolved_commit',base_sha),
    'candidate_revision',jsonb_build_object('binding','quincy_verified_checkout','resolved_commit',candidate_sha),
    'compatibility',jsonb_build_object('compatible',true),
    'integrity',jsonb_build_object('baseline_evidence_digest',baseline_digest,
      'candidate_observation_digest',candidate_digest),
    'evidence_references',jsonb_build_object('baseline',baseline_digest,
      'candidate_observation',candidate_digest),
    'compared_at',now(),
    'baseline_completeness',jsonb_build_object('discovery','complete','analysis','complete','findings','complete'),
    'candidate_completeness',jsonb_build_object('discovery','complete','analysis','complete','findings','complete'),
    'baseline_coverage',jsonb_build_object('available',true,'ledger_complete',true,'truncated',false),
    'candidate_coverage',jsonb_build_object('available',true,'ledger_complete',true,'truncated',false,
      'entries',jsonb_build_array(jsonb_build_object('path','src/fixture.js','state','analyzed','result_source','fresh'))));
  insert into public.quincy_scan_evidence(project_id,quincy_scan_execution_id,
    repository_id,requested_revision,resolved_revision,snapshot_id,status,
    scanner_summaries,observations,comparisons,evidence_digest)
  values(p,candidate_execution,'fixture-repository',candidate_sha,candidate_sha,
    candidate_snapshot,'complete',jsonb_build_array(jsonb_build_object('scanner','schrift','succeeded',true)),
    jsonb_build_array(observation),jsonb_build_array(target_comparison),candidate_digest)
    returning id into candidate_id;

  insert into public.remediation_security_verifications(project_id,ticket_id,commit_sha,
    scanner,baseline_findings,current_findings,baseline_evidence_id,candidate_evidence_id,
    comparison_outcome,comparison_reason,verification_policy,final_decision,
    decision_evidence_digest,verified_at)
  values(p,ticket,candidate_sha,'quincy','[]'::jsonb,'[]'::jsonb,baseline_id,candidate_id,
    'not_detected','complete_comparable_scan_analyzed_target_scope',
    'bankai-complete-repository-differential-v1','accepted',candidate_digest,now())
  returning id into verification_id;

  begin
    perform public.remediation_command(jsonb_build_object('schema_version','1.0',
      'command_key','scrum30-positive-wrong-job','action','transition',
      'remediation_id',remediation_id,'expected_revision',revision,'state','VERIFIED',
      'quincy_job_id','wrong-job','quincy_scan_execution_id',candidate_execution,
      'verification_id',verification_id));
    raise exception 'mismatched execution identity was accepted';
  exception when others then
    if sqlerrm = 'mismatched execution identity was accepted' then raise; end if;
  end;

  result := public.remediation_command(jsonb_build_object('schema_version','1.0',
    'command_key','scrum30-positive-verified','action','transition',
    'remediation_id',remediation_id,'expected_revision',revision,'state','VERIFIED',
    'quincy_job_id','scrum30-positive-job','quincy_scan_execution_id',candidate_execution,
    'verification_id',verification_id));
  if result->>'state' is distinct from 'VERIFIED'
     or (result->>'current_attempt_id')::uuid is distinct from attempt_id then
    raise exception 'matching complete evidence did not authorize VERIFIED';
  end if;
end $$;
rollback;
select 'SCRUM-30 state-machine assertions passed' as test_result;

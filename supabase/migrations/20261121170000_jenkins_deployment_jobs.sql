-- Optional Jenkins-driven CD follows a passing, commit-matched remediation CI run.
alter table public.pipeline_runs add column if not exists deployment_status text
  check (deployment_status in ('queued','running','passed','failed','needs_review','cancelled'));
alter table public.pipeline_runs add column if not exists deployment_job_url text;
alter table public.pipeline_runs add column if not exists deployment_build_url text;
alter table public.pipeline_runs add column if not exists deployment_build_number integer;
alter table public.pipeline_runs add column if not exists deployment_target_url text;
alter table public.pipeline_runs add column if not exists deployment_error text;
alter table public.pipeline_runs add column if not exists deployment_started_at timestamptz;
alter table public.pipeline_runs add column if not exists deployment_completed_at timestamptz;

alter table public.tickets add column if not exists cd_status text not null default 'not_configured'
  check (cd_status in ('not_configured','queued','running','passed','failed','needs_review','cancelled'));
alter table public.tickets add column if not exists cd_run_url text;
alter table public.tickets add column if not exists cd_error text;
alter table public.tickets add column if not exists cd_target_url text;

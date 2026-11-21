-- Jenkins CI state for remediation pull requests. Jenkins credentials and
-- console output remain on the user's desktop; the API stores bounded summaries.
alter table public.tickets drop constraint if exists tickets_ci_status_check;
alter table public.tickets add constraint tickets_ci_status_check
  check (ci_status in ('pending_setup','queued','running','passed','failed','retrying','needs_review','cancelled'));

alter table public.pipeline_runs add column if not exists commit_sha text;
alter table public.pipeline_runs add column if not exists pull_request_number integer;
alter table public.pipeline_runs add column if not exists jenkins_job_url text;
alter table public.pipeline_runs add column if not exists jenkins_build_number integer;
alter table public.pipeline_runs add column if not exists jenkins_build_url text;
alter table public.pipeline_runs add column if not exists retry_count integer not null default 0;
alter table public.pipeline_runs add column if not exists failure_summary text;
alter table public.pipeline_runs add column if not exists claimed_by text;
alter table public.pipeline_runs add column if not exists claimed_at timestamptz;
alter table public.pipeline_runs add column if not exists updated_at timestamptz not null default now();
alter table public.pipeline_runs drop constraint if exists pipeline_runs_status_check;
alter table public.pipeline_runs add constraint pipeline_runs_jenkins_status_check
  check (status in ('queued','in_progress','completed','needs_review','cancelled'));
create index if not exists pipeline_runs_claim_idx on public.pipeline_runs(project_id, created_at) where status = 'queued';
create unique index if not exists pipeline_runs_ticket_commit_idx on public.pipeline_runs(ticket_id, commit_sha);

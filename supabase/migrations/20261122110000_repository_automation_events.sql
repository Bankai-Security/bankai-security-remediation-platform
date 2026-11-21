-- Deterministic scan identities keep initial scans and at-least-once GitHub
-- webhook deliveries idempotent. PR scan evidence is stored separately from
-- baseline findings, so remediation branches cannot feed duplicate tickets.
alter table public.scans add column if not exists scan_type text not null default 'baseline'
  check (scan_type in ('baseline', 'push', 'pull_request'));
alter table public.scans add column if not exists pull_request_number integer;
alter table public.scans add column if not exists event_key text;
alter table public.pipeline_runs add column if not exists manual_retry_requested boolean not null default false;

alter table public.scans drop constraint if exists scans_trigger_type_check;
alter table public.scans add constraint scans_trigger_type_check
  check (trigger_type in ('manual', 'webhook', 'initial'));

create unique index if not exists scans_project_event_key_uidx
  on public.scans (project_id, event_key)
  where event_key is not null;

create index if not exists scans_project_pr_revision_idx
  on public.scans (project_id, pull_request_number, commit_sha)
  where scan_type = 'pull_request';

alter table public.projects add column if not exists verification_provider text not null default 'none'
  check (verification_provider in ('none', 'jenkins', 'hosted_ci'));
alter table public.projects add column if not exists github_webhook_workflow_run_enabled boolean not null default false;

create table if not exists public.hosted_ci_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  github_run_id bigint not null,
  pull_request_number integer not null,
  head_branch text not null,
  commit_sha text not null check (commit_sha ~ '^[0-9a-fA-F]{40}$'),
  status text not null check (status in ('queued', 'in_progress', 'completed')),
  conclusion text check (conclusion in ('passed', 'failed', 'cancelled', 'needs_review')),
  html_url text not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, github_run_id, pull_request_number)
);

create index if not exists hosted_ci_runs_pr_idx on public.hosted_ci_runs(project_id, pull_request_number, created_at desc);
alter table public.hosted_ci_runs enable row level security;
create policy "Project members can view hosted CI runs"
  on public.hosted_ci_runs for select
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and (
      p.owner_id = auth.uid()
      or exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id = auth.uid())
    )
  ));

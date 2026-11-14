-- Sprint 01 S06c: retain Quincy/Schrift evidence once per execution and
-- reference it from findings and remediation decisions. Large observations
-- are not duplicated in each finding or verification row.

create table if not exists public.quincy_scan_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  bankai_scan_id uuid references public.scans (id) on delete set null,
  quincy_scan_execution_id text not null,
  repository_id text,
  requested_revision text,
  resolved_revision text,
  snapshot_id text,
  status text not null check (status in ('complete', 'partial', 'failed', 'cancelled', 'incomparable')),
  scanner_summaries jsonb not null default '[]'::jsonb,
  observations jsonb not null default '[]'::jsonb,
  comparisons jsonb not null default '[]'::jsonb,
  evidence_digest text not null check (evidence_digest ~ '^sha256-[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (project_id, quincy_scan_execution_id)
);

create index if not exists quincy_scan_evidence_project_idx
  on public.quincy_scan_evidence (project_id, created_at desc);

alter table public.quincy_scan_evidence enable row level security;

create policy "Users can view Quincy evidence for their projects"
  on public.quincy_scan_evidence for select
  using (exists (
    select 1 from public.projects p
    where p.id = project_id and p.owner_id = auth.uid()
  ));

alter table public.findings add column if not exists scanner_provenance jsonb;
alter table public.findings add column if not exists legacy_fingerprint text;
alter table public.findings add column if not exists occurrence_id text;
alter table public.findings add column if not exists confidence_as_reported text;

alter table public.remediation_security_verifications
  add column if not exists baseline_evidence_id uuid references public.quincy_scan_evidence (id) on delete restrict;
alter table public.remediation_security_verifications
  add column if not exists candidate_evidence_id uuid references public.quincy_scan_evidence (id) on delete restrict;
alter table public.remediation_security_verifications add column if not exists comparison_outcome text;
alter table public.remediation_security_verifications add column if not exists comparison_reason text;
alter table public.remediation_security_verifications add column if not exists verification_policy text;
alter table public.remediation_security_verifications add column if not exists final_decision text;
alter table public.remediation_security_verifications add column if not exists decision_evidence_digest text;

alter table public.remediation_security_verifications
  drop constraint if exists remediation_security_verifications_comparison_outcome_check;
alter table public.remediation_security_verifications
  add constraint remediation_security_verifications_comparison_outcome_check
  check (comparison_outcome is null or comparison_outcome in ('still_detected', 'not_detected', 'inconclusive', 'not_comparable'));

alter table public.remediation_security_verifications
  drop constraint if exists remediation_security_verifications_final_decision_check;
alter table public.remediation_security_verifications
  add constraint remediation_security_verifications_final_decision_check
  check (final_decision is null or final_decision in ('accepted', 'rejected', 'inconclusive'));

-- Bankai-owned scanner execution metadata. Preserve old Quincy evidence tables
-- and remediation history for audit/read compatibility; new scans are Bankai-owned.
alter table public.scans
  add column if not exists scanner_runs jsonb not null default '[]'::jsonb,
  add column if not exists scan_complete boolean not null default false;

comment on column public.scans.scanner_runs is
  'Per-scanner name/version/outcome/finding-count metadata for the pinned Bankai scan.';
comment on column public.scans.scan_complete is
  'True only when all applicable Bankai scanners completed against the full pinned repository revision.';

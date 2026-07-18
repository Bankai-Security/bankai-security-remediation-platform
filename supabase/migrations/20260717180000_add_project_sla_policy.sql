-- Per-project SLA remediation windows (days), replacing the fixed
-- SLA_POLICY_DAYS constant in backend/src/lib/sla.ts. Defaults match that
-- constant so existing projects keep behaving exactly as before until
-- someone edits them from Settings.

alter table public.projects add column if not exists sla_critical_days integer not null default 7;
alter table public.projects add column if not exists sla_high_days integer not null default 30;
alter table public.projects add column if not exists sla_medium_days integer not null default 90;
alter table public.projects add column if not exists sla_low_days integer not null default 180;

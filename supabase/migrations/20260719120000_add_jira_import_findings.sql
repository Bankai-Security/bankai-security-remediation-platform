-- Lets reconcileJiraTickets() (backend/src/lib/ticketing.ts) create a new
-- local finding straight from a Jira issue that carries our Fingerprint
-- marker but has no matching local finding yet (e.g. a different Bankai
-- project/account pointed at the same Jira project already created it).
-- Such a finding has no originating scan, so scan_id must be optional.
alter table public.findings alter column scan_id drop not null;

alter table public.findings drop constraint if exists findings_source_check;
alter table public.findings add constraint findings_source_check
  check (source in ('csv', 'github_ai', 'jira_import'));

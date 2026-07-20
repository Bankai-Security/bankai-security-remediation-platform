-- Adds the fields needed for the standardized Jira ticket description
-- format (Team/Service/Environment/Priority/Finding Count/TTR Status/CVEs/
-- Image/Affected Packages/Current Versions/Fixed Versions/Recommendations)
-- plus the project-level "Team name" Settings field. The findings columns
-- are free-form multi-line text, same pattern as the existing `description`
-- column, so CSV ingestion and description rendering need no new parsing.

alter table public.projects add column if not exists team_name text;

alter table public.findings add column if not exists environment text;
alter table public.findings add column if not exists cves text;
alter table public.findings add column if not exists affected_packages text;
alter table public.findings add column if not exists current_versions text;
alter table public.findings add column if not exists fixed_versions text;
alter table public.findings add column if not exists recommendations text;

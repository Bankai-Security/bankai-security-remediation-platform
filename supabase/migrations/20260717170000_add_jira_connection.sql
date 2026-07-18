-- Real Jira Cloud connection (API-token Basic Auth). jira_site/jira_key on
-- projects already existed as freeform labels; they now become the actual
-- connected values, populated only via the /jira/connect flow — never at
-- project-creation time. jira_connected_at is the single source of truth
-- for "is Jira actually connected" (do not conflate with projects.status,
-- which tracks first-scan-uploaded, not Jira).

alter table public.projects add column if not exists jira_email text;
alter table public.projects add column if not exists jira_api_token_enc text;
alter table public.projects add column if not exists jira_connected_at timestamptz;

alter table public.tickets add column if not exists jira_issue_key text;
alter table public.tickets add column if not exists jira_issue_url text;
alter table public.tickets add column if not exists jira_sync_error text;

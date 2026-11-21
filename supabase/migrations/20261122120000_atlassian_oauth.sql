-- Jira Cloud 3LO credentials are project-scoped and encrypted by the API.
-- Access tokens expire quickly; refresh tokens rotate and must be replaced
-- after every successful refresh.
alter table public.projects add column if not exists jira_cloud_id text;
alter table public.projects add column if not exists jira_oauth_access_token_enc text;
alter table public.projects add column if not exists jira_oauth_refresh_token_enc text;
alter table public.projects add column if not exists jira_oauth_expires_at timestamptz;
alter table public.projects add column if not exists jira_oauth_account_id text;

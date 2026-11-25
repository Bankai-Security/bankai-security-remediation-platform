-- Account-level Atlassian OAuth grant used to connect Jira projects without
-- repeating consent. Tokens are encrypted by the backend before persistence.
alter table public.profiles add column if not exists jira_oauth_access_token_enc text;
alter table public.profiles add column if not exists jira_oauth_refresh_token_enc text;
alter table public.profiles add column if not exists jira_oauth_expires_at timestamptz;
alter table public.profiles add column if not exists jira_oauth_connected_at timestamptz;
alter table public.projects add column if not exists jira_oauth_user_id uuid references public.profiles(id) on delete set null;

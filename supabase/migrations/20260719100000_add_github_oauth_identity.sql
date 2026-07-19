-- Per-user GitHub identity, obtained via OAuth ("Connect your GitHub
-- account" in Settings) so a single grant can be reused across every
-- project's repo picker — distinct from the existing per-project PAT
-- connection on `projects` (20260718100000_add_github_connection.sql),
-- which remains available as a manual fallback.

alter table public.profiles add column if not exists github_user_id text;
alter table public.profiles add column if not exists github_login text;
alter table public.profiles add column if not exists github_user_token_enc text;
alter table public.profiles add column if not exists github_oauth_scope text;
alter table public.profiles add column if not exists github_oauth_connected_at timestamptz;

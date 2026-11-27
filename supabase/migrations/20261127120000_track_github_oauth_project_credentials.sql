-- Keep account OAuth-backed project credentials in sync when a user
-- reauthorizes GitHub. Manual PAT connections leave this null.
alter table public.projects
  add column if not exists github_oauth_user_id uuid references public.profiles(id) on delete set null;

create index if not exists projects_github_oauth_user_id_idx
  on public.projects (github_oauth_user_id)
  where github_oauth_user_id is not null;

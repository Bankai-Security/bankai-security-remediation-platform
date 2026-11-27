-- One-time session handoff from the system browser back to Bankai Desktop.
-- Tokens are encrypted at rest and the random handoff code is stored only as
-- a SHA-256 digest. Codes expire after five minutes and are atomically spent.
create table if not exists public.desktop_auth_transfers (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  access_token_enc text not null,
  refresh_token_enc text not null,
  expires_in integer not null check (expires_in > 0),
  is_new_user boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.desktop_auth_transfers enable row level security;
revoke all on public.desktop_auth_transfers from public, anon, authenticated;
grant all on public.desktop_auth_transfers to service_role;

create or replace function public.consume_desktop_auth_transfer(p_code_hash text)
returns table(access_token_enc text, refresh_token_enc text, expires_in integer, is_new_user boolean)
language sql
security definer
set search_path = ''
as $$
  delete from public.desktop_auth_transfers as transfer
  where transfer.code_hash = p_code_hash
    and transfer.expires_at > now()
  returning transfer.access_token_enc, transfer.refresh_token_enc, transfer.expires_in, transfer.is_new_user;
$$;

revoke all on function public.consume_desktop_auth_transfer(text) from public, anon, authenticated;
grant execute on function public.consume_desktop_auth_transfer(text) to service_role;

-- AI-powered GitHub repo scanning: webhook registration state on projects,
-- a source/status/commit vocabulary on scans so CSV and GitHub-AI scans
-- share one history table, and the extra fields findings need to carry a
-- long-form AI remediation write-up and an exact GitHub file/line anchor.

alter table public.projects add column if not exists github_webhook_secret_enc text;
alter table public.projects add column if not exists github_webhook_id text;
alter table public.projects add column if not exists github_webhook_registered_at timestamptz;

-- ---------------------------------------------------------------------
-- scans: add a source discriminator and GitHub-scan metadata. Widen the
-- status vocabulary to cover the async Queued/Processing lifecycle a
-- GitHub scan goes through before landing on Done/Failed — CSV uploads
-- keep inserting directly as Done/Failed and never observe the new states.
-- ---------------------------------------------------------------------
alter table public.scans add column if not exists source text not null default 'csv' check (source in ('csv', 'github_ai'));
alter table public.scans add column if not exists trigger_type text check (trigger_type in ('manual', 'webhook'));
alter table public.scans add column if not exists commit_sha text;
alter table public.scans add column if not exists base_commit_sha text;
alter table public.scans add column if not exists branch text;
alter table public.scans add column if not exists bullmq_job_id text;
alter table public.scans add column if not exists finding_count integer;

alter table public.scans drop constraint if exists scans_status_check;
alter table public.scans add constraint scans_status_check
  check (status in ('Queued', 'Processing', 'Done', 'Failed'));

-- filename/row_count are CSV-shaped and NOT NULL today; GitHub scans have
-- no uploaded file, so relax both to make room for the new source.
alter table public.scans alter column filename drop not null;

-- ---------------------------------------------------------------------
-- findings: remediation_guidance is the long, actionable AI write-up —
-- deliberately separate from the existing `rationale` column, which stays
-- the short bucket-assignment explanation (CSV and AI sourced alike).
-- commit_sha + line_start/line_end let the UI link straight to the exact
-- GitHub blob a finding was observed at.
-- ---------------------------------------------------------------------
alter table public.findings add column if not exists remediation_guidance text;
alter table public.findings add column if not exists line_start integer;
alter table public.findings add column if not exists line_end integer;
alter table public.findings add column if not exists commit_sha text;
alter table public.findings add column if not exists source text not null default 'csv' check (source in ('csv', 'github_ai'));

-- ---------------------------------------------------------------------
-- create_project_ticket_system: a service-role-only counterpart to
-- create_project_ticket. The repo-scan worker has no authenticated
-- session (no JWT, so auth.uid() is null) — it runs entirely on the
-- service-role client, which already bypasses RLS. create_project_ticket
-- itself can't be reused as-is because it calls project_role(), which
-- resolves via auth.uid() and would always return null for the worker,
-- rejecting every call with "Editor access required".
--
-- Rather than weaken create_project_ticket's own auth check, this is a
-- separate function with the identical body minus the project_role()
-- gate, and its EXECUTE grant is restricted to service_role only (revoked
-- from public/authenticated) — so the "who may call this" boundary is
-- enforced by Postgres GRANTs, not an in-function role check, which is
-- the correct pattern for a function only ever meant to be invoked by
-- trusted backend code, not end users.
-- ---------------------------------------------------------------------
create or replace function public.create_project_ticket_system(
  p_project_id uuid,
  p_finding_id uuid,
  p_title text,
  p_service text,
  p_severity text,
  p_due_date date
) returns public.tickets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq integer;
  v_prefix text;
  v_ticket public.tickets;
begin
  update public.projects
    set ticket_seq = ticket_seq + 1
    where id = p_project_id
    returning ticket_seq, key_prefix into v_seq, v_prefix;

  if v_seq is null then
    raise exception 'Project not found' using errcode = 'P0002';
  end if;

  insert into public.tickets (project_id, finding_id, key, title, service, severity, due_date)
  values (p_project_id, p_finding_id, coalesce(v_prefix, 'PRJ') || '-' || (100 + v_seq), p_title, p_service, p_severity, p_due_date)
  returning * into v_ticket;

  return v_ticket;
end;
$$;

revoke all on function public.create_project_ticket_system(uuid, uuid, text, text, text, date) from public;
revoke all on function public.create_project_ticket_system(uuid, uuid, text, text, text, date) from authenticated;
grant execute on function public.create_project_ticket_system(uuid, uuid, text, text, text, date) to service_role;

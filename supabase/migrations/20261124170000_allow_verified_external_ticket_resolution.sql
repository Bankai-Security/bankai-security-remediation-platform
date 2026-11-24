-- A complete scan of the repository's current default branch can verify that
-- a finding has already been fixed outside Bankai. Record that evidence on the
-- ticket and allow it to close without fabricating a merged PR.
alter table public.tickets drop constraint if exists tickets_github_pr_state_check;
alter table public.tickets add constraint tickets_github_pr_state_check
  check (github_pr_state in ('open', 'merged', 'closed', 'resolved_externally'));

create or replace function public.enforce_ticket_completion_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'Done'
    and new.github_pr_state is distinct from 'merged'
    and new.github_pr_state is distinct from 'resolved_externally' then
    new.status := case when new.github_pr_number is not null then 'In Review' else 'In Progress' end;
  end if;
  return new;
end;
$$;

comment on function public.enforce_ticket_completion_gate() is
  'Allows Done after a merged remediation PR or verified absence in a complete default-branch scan.';

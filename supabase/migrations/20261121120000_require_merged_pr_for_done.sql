-- Keep ticket completion independent of the retired CI and verification paths.
-- A merged remediation PR is the sole ticket completion gate.
drop trigger if exists enforce_ticket_completion_gate on public.tickets;

create or replace function public.enforce_ticket_completion_gate()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'Done' and new.github_pr_state is distinct from 'merged' then
    new.status := case when new.github_pr_number is not null then 'In Review' else 'In Progress' end;
  end if;
  return new;
end;
$$;

create trigger enforce_ticket_completion_gate
  before insert or update of status, github_pr_number, github_pr_state
  on public.tickets for each row execute function public.enforce_ticket_completion_gate();

comment on function public.enforce_ticket_completion_gate() is
  'Allows Done only after a remediation pull request is merged.';

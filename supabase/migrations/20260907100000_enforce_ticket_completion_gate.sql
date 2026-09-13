-- A ticket is complete only after its remediation PR has merged and its
-- verification pipeline has passed. Repair older drift before installing the
-- write guard so the Kanban board and aggregate counts agree immediately.
update public.tickets
set status = case
  when github_pr_number is not null then 'In Review'
  else 'In Progress'
end
where status = 'Done'
  and ((github_pr_state = 'merged' and ci_status = 'passed') is not true);

create or replace function public.enforce_ticket_completion_gate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'Done'
     and ((new.github_pr_state = 'merged' and new.ci_status = 'passed') is not true) then
    new.status := case
      when new.github_pr_number is not null then 'In Review'
      else 'In Progress'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ticket_completion_gate on public.tickets;

create trigger enforce_ticket_completion_gate
  before insert or update of status, github_pr_number, github_pr_state, ci_status
  on public.tickets
  for each row execute function public.enforce_ticket_completion_gate();

comment on function public.enforce_ticket_completion_gate() is
  'Prevents tickets from reaching Done until their remediation PR is merged and CI has passed.';

-- tickets was missing a DELETE policy, so ticket.controller.ts's syncTickets
-- (removing a Bankai ticket whose linked Jira issue was deleted) was
-- silently blocked by RLS: PostgREST matched 0 rows and returned no error,
-- so the ticket never actually disappeared even though the response
-- claimed it was removed.

create policy "Users can delete tickets of their own projects"
  on public.tickets for delete
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

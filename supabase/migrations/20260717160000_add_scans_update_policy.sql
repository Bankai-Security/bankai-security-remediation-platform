-- scans is missing an UPDATE policy, so scan.controller.ts's finalize step
-- (writing new_delta_count/changed_count/in_progress_count/resolved_count/
-- service_count after triage) is silently blocked by RLS: PostgREST matches
-- 0 rows and returns no error, so scans stay stuck at their inserted
-- defaults (all 0) forever.

create policy "Users can update scans of their own projects"
  on public.scans for update
  using (exists (select 1 from public.projects p where p.id = project_id and p.owner_id = auth.uid()));

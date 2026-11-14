# Supabase isolated restore drill

Status on 2026-10-28: **BLOCKED**. The operator confirmed there is no separate
nonproduction Supabase project. No source database has been restored in place.
An approved local backup and its Postgres version would allow an isolated local
drill without a second hosted project. No backup has yet been supplied.

## Prepare the recovery target

1. In the source project's Dashboard, inspect Database > Backups. Record the
   project reference, backup timestamp, backup type and Postgres image version
   (the `PG:` version). Do not record credentials or row contents in evidence.
2. If a downloadable backup is available, save it outside source control in an
   access-restricted directory. Supply the approved local path and image version
   to the recovery operator. Preserve the original backup and calculate SHA-256.
3. If no downloadable backup exists, use the official logical backup procedure
   with approved source access. Capture roles, schema and data separately; a
   default CLI dump does not include data or custom roles. Review auth/storage
   customizations and migration history separately. Do not put passwords in
   commands, chat, CI logs or Git. Physical backups cannot be treated as SQL dumps.
4. Create a dedicated local Docker workspace with a unique Supabase project ID,
   nonconflicting ports, sufficient disk space and the matching supported
   Postgres image. Isolate outbound network access before starting restored data:
   restored cron jobs, webhooks and extension jobs must not contact live systems.
5. Following Supabase's local-restore procedure, initialize the dedicated
   workspace, record the image version in `supabase/.temp/postgres-version`, and
   run `supabase db start --from-backup` with the approved backup path. Never
   link this workspace to the source project or run a remote reset/restore.

## Validate and retain evidence

- Start the recovery timer before creating the restore target. Record successful
  database startup and validation time, image digest/version and backup checksum.
- Validate expected schemas, migrations, table counts, constraints and RLS
  policies. Compare approved aggregate counts/watermarks with the source backup
  inventory; avoid exporting personal data into the readiness report.
- Test Bankai against only the isolated target with synthetic identities and
  external integrations disabled. Database startup alone is not application RTO.
- Record RPO as the difference between the agreed recovery point and the latest
  successfully recovered committed-data watermark. Do not substitute backup age
  or elapsed restore duration for measured data loss.
- Database backups do not contain Storage object bytes. Recover and verify these
  separately if Bankai uses them. Auth settings, API keys, Edge Functions and
  other service configuration require separate recovery checks.
- Preserve backup, logs and evidence. Record target shutdown separately; do not
  delete volumes or use `supabase stop --no-backup` as part of this drill.

Pass criteria: verified backup provenance, isolated restore, reconciled data and
policies, successful application checks, measured RPO/RTO and operator review.
Until those exist, Phase 11 database recovery remains incomplete.

## Official references (checked 2026-10-28)

- [Restore a downloaded backup locally](https://supabase.com/docs/guides/local-development/restoring-downloaded-backup)
- [Logical backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
- [Backup coverage and limitations](https://supabase.com/docs/guides/platform/backups)
- [New-project restore and external extension behavior](https://supabase.com/docs/guides/platform/clone-project)

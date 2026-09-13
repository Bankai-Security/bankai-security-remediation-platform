# Live remediation verification: BAN-127

Verified on 2026-09-06 against `anubhavgpta/bankai-e2e-vulnerable-app`.

## Result

- Bankai ticket: BAN-127 (`2ff84bce-20d6-4e35-8898-aa22b6bfc941`), In Review, CI passed, no remediation or CI error.
- Jira: [TT2-66](https://bankaisecurity.atlassian.net/browse/TT2-66), In Review; the real CI run evidence is present in its comments.
- Quincy job: `a3efad66ac214b03a4b50e6f97ef671c`, succeeded in one attempt after the transport/context corrections.
- Branch: `remediation/quincy/a3efad66ac21`.
- PR: [#27](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/pull/27), open for review; not merged.
- Final commit: `c8300e465ee86e65431ef1b3a0c3d401be15a6e6`.
- [GitHub Actions run 34048945658](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/actions/runs/34048945658): build, image, deploy-dev, functional-test, and integration-test all succeeded. The run's head SHA exactly matches the current PR head.
- Bankai persisted the run and all five stage results after receiving the GitHub webhook through ngrok.

## Fix and independent checks

The finding was `bandit:B602` in `export_report_csv`, originally line 22 of
`backend/app/utils/report_export.py`. The discarded shell command after CSV
creation was removed. A subsequent review restored the `subprocess` import
needed by the separate, unchanged preview helper.

The final contents were rescanned using Quincy's configured scanner factory.
Target fingerprint `356e10b8de4a7afb0688ee1c8908277493b68a5d93c73b492e5659d78991442d`
was absent; there were no new scanner findings compared with Quincy's baseline.
There are still other intentional vulnerabilities in this test app; this run
remediated one specific finding.

The built application image passed 8 backend tests with 1 existing skipped
test. New regression tests exercise actual CSV output with SQLite, prevent
subprocess invocation for shell metacharacters, and check that the separate
preview helper retains its dependency. The same regression suite failed against
the original vulnerable source, including `Unexpected subprocess invocation`.
The real development container's `/health` endpoint also returned `status: ok`.

The PR replaces placeholder CI commands with real dependency installation,
compilation, Docker image construction, an isolated development container health
check, the backend suite, and focused integration tests. The development
container is temporary, not a production deployment. A conflicting duplicate
`requests` pin was removed, retaining the newer version already in the file.

## Pipeline corrections

- DeepSeek/OpenRouter requests in both Bankai and Quincy disable thinking by
  default so completion tokens are available for the actual JSON artifact.
  Quincy's transport now has an explicit timeout and bounded SDK retries.
- Quincy selects the ticket's file and nearest reported location rather than
  an unrelated occurrence of the same scanner rule. Stored remediation
  guidance is preserved when the scanner rediscovers the finding.
- Patch retry instructions state that failed patches have not been applied to
  the original source, keep tests in `test_diffs`, and preserve imports unless
  the complete file proves they are unused.
- Bankai requires a Quincy-validated PR when Quincy is configured. An explicit
  `QUINCY_ALLOW_FALLBACK=true` is required to permit the old fallback behavior.
- AI/CSV findings without scanner IDs use their stored context and require
  executable proof; scanner absence alone cannot prove a synthetic rule fixed.
- Inline workers are opt-in, avoiding the default API-plus-dedicated-worker
  duplication. The all-services launcher waits for Quincy health.
- Placeholder verification workflows stay at `pending_setup`. Certification
  requires all five stages to pass, and older commit results cannot certify
  newer code. Dispatch polling excludes already-existing runs.

Validation: Bankai typecheck, build, lint, and 136 tests passed. Quincy's 7
OpenRouter adapter tests and 33 remediation-loop tests passed.

## Remaining configuration note

The connected Supabase database lacks the optional
`pipeline_runs.jira_comment_posted_at` column. Jira did receive this run's CI
evidence, but durable comment deduplication requires the existing migration
`supabase/migrations/20260721180000_add_pipeline_jira_comment_tracking.sql`.
No database migration was applied during this run. The verified remediation and
all five CI stages completed despite that separate schema discrepancy.

The real verification workflow is part of PR #27. It reaches the repository's
default branch when that PR is reviewed and merged; other branches that still
contain the old placeholder workflow correctly remain pending setup.

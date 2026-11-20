# Bankai simplification implementation plan

## Target workflow

Bankai scans repositories and ingested reports, owns finding normalization and triage, creates a remediation branch and pull request, and leaves review and merge to the user. Bankai does not run or track CI, verify fixes, or merge pull requests. Quincy and Schrift are retired as services and product dependencies.

## Implementation sequence

1. **Establish the Bankai-only scan path.** Run the complete Quincy repository scanner set from Bankai's isolated scan worker against one pinned repository revision: Trivy, Semgrep, Bandit, Gitleaks, OSV Scanner, `npm audit`, and `pip-audit`. Run ecosystem-specific tools only when their manifests or source types are present and record those tools as skipped when not applicable. Normalize results and retain scanner name/version, commit SHA, completion status, finding count, and safe failure details. Do not persist raw scanner output because it can contain secret material. Any failed, truncated, or capped scanner run must be visibly partial and must not reconcile findings or mark older findings resolved. Keep CSV intake and Bankai's existing triage, deduplication, SLA, and ticket workflows.

   | Scanner | Bankai scan responsibility | When it runs |
   | --- | --- | --- |
   | Trivy | Dependency vulnerabilities, secrets, and IaC/misconfiguration findings | Every supported repository scan |
   | Semgrep | Static application security rules | Every supported repository scan |
   | Bandit | Python security lint findings | When Python files are present |
   | Gitleaks | Secret detection | Every supported repository scan |
   | OSV Scanner | Dependency vulnerability/advisory coverage | When supported lockfiles/manifests are present |
   | `npm audit` | npm dependency advisories | When npm manifests/lockfiles are present |
   | `pip-audit` | Python dependency advisories | When supported Python dependency manifests/lockfiles are present |

   Avoid duplicate tickets by correlating scanner-native IDs and package/advisory identity in Bankai triage. Preserve scanner provenance on each finding so users can see why it was reported. A successful empty result from one scanner must not mask another scanner's failure; only complete coverage across the applicable scanner set may contribute negative evidence.
2. **Make remediation a user handoff.** Keep Bankai's patch generation, remediation branch, PR creation, and PR comments. Remove Quincy dispatch/polling and verification attempts. A PR moves its ticket to review; GitHub PR webhooks record open/closed/merged state. Merging is always performed by the user. Do not require CI to close a ticket.
3. **Remove the CI product feature.** Remove the verification queue and retry worker, workflow-run webhook handling, CI retry routes, CI status controls, local-verification screens/routes, runner pairing and APIs, and CI setup instructions. Keep old database columns/tables and migrations readable for historical records; use forward-only migrations for any schema changes.
4. **Remove Quincy and Schrift integration.** Remove backend clients, config, checkpoints, manifest and verification code, runner desktop dependency, Quincy launch scripts, deployment configuration, and active documentation. Preserve unrelated local work and historical records. Quincy and Schrift repositories themselves are retired separately after a history/retention review.
5. **Cut over Railway safely.** Deploy the Bankai-only application first and verify staging health, scans, triage, remediation PR creation, and manual PR merge tracking. Then remove the Quincy service and its runtime variables. Preserve Railway Postgres/Redis data and backups. Production currently has no services; do not create production services as part of this cutover.

## Completion criteria

- A repository scan runs Trivy in Bankai and persists findings tied to a commit.
- All scanners in the selected Quincy repository set run within Bankai: Trivy, Semgrep, Bandit, Gitleaks, OSV Scanner, npm audit, and pip-audit.
- Incomplete scans cannot resolve findings.
- Bankai triage, tickets, branch creation, fix generation, PR creation, and merge-state tracking work without Quincy/Schrift.
- No CI or verification controls/routes/jobs remain in the product flow.
- Ticket UI consistently shows remediation progress and the PR handoff, with explicit user review/manual merge language.
- Railway staging runs Bankai without Quincy; production remains untouched unless separately requested.
- Existing findings, tickets, and audit history remain available.

## Implementation status

The Bankai application, scanner image, manual PR handoff, CI product-flow removal, historical-data-preserving migration, and non-production Railway cleanup patch are prepared. The Railway patch is staged for review; it has not been applied or deployed. Railway's connected tool can set the obsolete runtime variables to empty values but cannot remove individual keys, so those key removals still require the Railway dashboard. Deploying the source changes also requires a new Bankai build from the user's repository.

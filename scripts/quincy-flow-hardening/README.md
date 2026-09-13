# Remediation flow hardening

The Bankai changes verify that a Quincy result identifies an open pull request in the connected repository with a real diff before moving a ticket to In Review. Redis checkpoints retain the Quincy job ID across worker restarts; bounded polling resumes the existing job instead of starting another remediation. Temporary status outages remain pending, and CI verification correlates synthetic ticket findings with scanner results by file, CWE, and line range.

The accompanying Quincy patches are ordered:
1. quincy.patch
2. dependencies-and-exact-edits.patch
3. exact-edit-precedence.patch
4. provider-recovery.patch
5. scanner-correlation.patch

After those patches, apply `deadline-progress/install.ps1 -QuincyPath <engine checkout>` (September 11 update). This bundle verifies both existing and replacement hashes before copying; it refuses to overwrite unexpected source changes. Drain active work before restarting Quincy. The bundle is already installed locally.

The September 11 update adds a wall-clock deadline around each complete OpenRouter model call, including SDK retries and transport backoff (120 seconds by default, using `openrouter_timeout_seconds`). Patch retries no longer enable reasoning automatically. Task-local progress is persisted in Quincy's workflow record and exposed by its Bankai status API, including active and completed attempts. Bankai caches these updates and refreshes the Tickets view every ten seconds; a progress-cache failure does not discard a valid remediation result. API tokens and model prompts are not included in progress messages. Retry feedback now includes pytest output from both stdout and stderr. A complete replacement of an existing test file is accepted only when it is the sole edit for that file and preserves every existing test name. Proof classification distinguishes application-level file errors from missing runtimes and other infrastructure failures.

Validation for this update: 66 focused Quincy tests, including cancellation of slow provider calls, retry-deadline coverage, progress persistence, patch feedback, guarded test replacement, and proof classification; 159 Bankai backend tests; backend typecheck and frontend production build.

They are already applied to the local sibling quincy-security-engine checkout. They are retained here because Quincy is a separate repository; deploying Bankai alone will not deploy these engine changes. Existing unrelated changes in both repositories were preserved.

Engine behavior:
- Select the built-in runtime per finding, including Node image tags such as :test, without mutating process-wide settings.
- Find nested Python/Node project tests. For Python pytest suites, reuse an existing CI in-container setup/test sequence when present.
- Prepare a cached Python dependency image from requirements.txt, using the Python major/minor from the repository Dockerfile when available. Only the manifest and generated Dockerfile enter this build; application tests still run as non-root with no network and no host mounts.
- Supply the nested Python import path and a writable temporary directory.
- Accept exact text edits and construct unified diffs deterministically. Reject missing/ambiguous matches, unsafe paths, malformed hunks, and no-op replacements.
- Validate patch application before sandbox execution and retain concrete errors for the next attempt.
- Execute the same proof test against original and patched source. Missing runtimes, import errors, and syntax errors do not prove a vulnerability.
- Stop runtime setup failures before spending model attempts on application changes.
- Retry transient provider connections, preserve completed attempt evidence on provider failure, and use additional reasoning for repair feedback and patch retries.

Validation completed locally: Bankai typecheck and 158 backend tests; 81 focused Quincy regression tests and 67 model/schema tests, followed by 35 remediation-loop tests including the added scanner-correlation regression; actual isolated Docker backend suite: 8 passed, 1 existing skip. Quincy suite counts overlap.

Live verification on September 9, 2026: BAN-130 / TT2-69 completed Quincy validation and opened [PR #31](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/pull/31), head `2489631ae17a8f8101d8fceae3ab01f3eddcb102`. The [verification workflow](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/actions/runs/34383862069) passed build, image, deploy-dev, functional-test, and integration-test. Bankai reports In Review, CI passed, and no remediation or CI error. The PR remains open for human review and merge.

Live verification on September 11, 2026: BAN-133 / TT2-72 completed on its first attempt after the proof-classifier correction and opened [PR #34](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/pull/34), head `b1f66ca983b692e862d3f05592ed93d7a028a8c7`. The [verification workflow](https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/actions/runs/34572972369) passed build, image, deploy-dev, functional-test, and integration-test. Bankai and Jira report In Review with CI passed.

These changes are installed in the local running services and remain uncommitted source changes. The local worker, API, Quincy, Redis, Docker, and public webhook tunnel must remain available for further assignments; this is not a remote production deployment.

Supported automatic dependency preparation currently covers ordinary package-index requirements.txt entries. Local/URL/recursive Python dependencies, other package managers, and custom build environments need a configured sandbox image and test command. Failed validation remains actionable and keeps the ticket In Progress; these changes do not guarantee that an AI can safely fix every arbitrary vulnerability.

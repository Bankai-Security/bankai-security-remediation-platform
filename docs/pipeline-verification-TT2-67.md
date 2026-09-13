# TT2-67 pipeline verification

Verified September 7, 2026 against `anubhavgpta/bankai-e2e-vulnerable-app`.

## Result

- Ticket: TT2-67 / BAN-128, Starlette CVE-2025-54121.
- Corrective PR: https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/pull/29
- Commit: `34485d4b58618d882435adece4b0805f9aad49ed`.
- Verification run: https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/actions/runs/34081354668
- Build, image, deploy-dev, functional-test, and integration-test: all successful.
- Bankai: In Review, CI passed, no CI error. Jira: In Review.
- PR merge remains the reviewer's action. No PR was merged by this agent.

## Fixes

Scanner omission no longer auto-closes tickets without a merged PR and passing verification. Assignment can start remediation despite a stale Resolved finding bucket; reopening also recovers prematurely completed tickets that never received a PR. Assignment to an existing open PR re-enqueues verification.

PR merge and CI completion both reconcile ticket status. A merge with failed or missing CI stays In Review. Only merged fixes with passed verification qualify as Done.

Quincy preserves advisory package and fixed-version metadata, adds bounded live PyPI parent-dependency facts, and limits failure-analysis context to the target and newly introduced findings. Checks delegated to CI do not distract its retry analysis.

Before every CI dispatch, Bankai compares Quincy scans of the exact base and proposed commit. The target must be absent and no new scanner findings may appear. Scanner unavailability blocks dispatch. A security regression feeds an automatic, bounded retry on the same PR. Python retries now receive Docker and CI runtime files, registry constraints, and explicit instructions to preserve the security fix.

Quincy supports immutable commit checkout and scanner-only verification without unnecessary AI scoring. The scanner-only path requires successful configured-scanner results.

## Live failures exercised

Quincy opened PR #28 after scanner validation. CI detected incompatible dependency pins; the first automatic build repair downgraded Starlette to an affected version. The added security gate rejected that regression and triggered another repair. The upgraded dependencies then failed under Python 3.9. PR #28 was merged externally before that failed build was corrected.

PR #29 updates Docker and both CI workflows to Python 3.11, retaining the patched dependencies and every existing test step. This is a follow-up to the already merged PR, not an automatic merge or a bypass of verification.

## Validation

- Bankai: 151 tests passed; TypeScript check passed; changed files linted.
- Quincy: 59 focused tests passed; changed verification and dependency modules linted.
- Corrective application image built; pip check passed.
- Container tests: 8 passed, 1 pre-existing skip; 3 security regression tests passed.
- Live Bankai-dispatched CI: all five stages passed.

## Frontend assignment verification

On September 7, 2026, assigning the existing BANKAI-001 SQL-injection finding created BAN-129 / Jira TT2-68 and immediately moved it to In Progress. BullMQ created fix job 98 and Quincy created the remediation branch. The first attempt exposed an overly broad JavaScript SQL rule that treated `api.get(...)` as a database call. The rule now requires a database-like receiver and has a Docker-backed Semgrep regression test.

The retry used the same ticket, passed Quincy validation, and opened https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/pull/30. CI run https://github.com/anubhavgpta/bankai-e2e-vulnerable-app/actions/runs/34083977028 passed build, image, deploy-dev, functional-test, and integration-test. Bankai recorded CI passed and kept BAN-129 In Review because PR #30 remains open. This exercises a non-command-injection finding and proves that passing CI alone cannot complete a ticket.

Quincy's scan-cache key now hashes file bytes instead of size and modification time, so a same-size rewrite during an automatic retry cannot reuse stale security results. Authenticated clone and exact-SHA scan requests also pass the project's GitHub token through Git's environment-only extra header, keeping private repositories supported without putting the token in command arguments.

- Bankai: 153 tests passed; backend typecheck passed; frontend production build passed.
- Quincy: 636 tests passed, 20 integration/environment skips; Ruff passed.
- Focused live Semgrep rule test: passed through Docker.

This verifies one dependency remediation and its failure/retry paths. It does not establish that every possible vulnerability can be repaired automatically. Failed checks remain visible and retries remain bounded.

## Premature Done guard

Ticket reads now repair legacy or racing status writes: a branch without a PR returns to In Progress, while any created but not fully completed PR returns to In Review. Jira reconciliation applies the same rule and cannot preserve or reintroduce a premature Done state. Project summaries use the guarded status as well.

Migration `20260907100000_enforce_ticket_completion_gate.sql` repairs existing rows and installs a database trigger that permits Done only when `github_pr_state = 'merged'` and `ci_status = 'passed'`. Regression coverage exercises branch-only, open-PR, merged-with-failed-CI, and fully complete states.

The live data repair inspected 11 completed tickets and corrected five invalid rows: JNI-101, JNI-102, JNI-103, BAN-109, and BAN-126. Each lacked the merged-PR plus passing-CI evidence and returned to In Progress. Six tickets with valid completion evidence remained Done.

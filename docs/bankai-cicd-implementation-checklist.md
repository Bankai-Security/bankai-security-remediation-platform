# Bankai CI/CD Implementation Checklist

This checklist turns the agreed CI/CD workflow into buildable implementation steps. Work top to bottom; each phase produces a usable increment.

## Phase 0: Confirm contracts and boundaries

- [ ] Map the current scan, finding triage, assignment, remediation, pull request, and GitHub integration flows.
- [ ] Decide which service owns pipeline orchestration, job state, and GitHub status updates.
- [ ] Define a shared pipeline state model: `not_configured`, `queued`, `running`, `passed`, `failed`, `retrying`, `needs_review`, and `cancelled`.
- [ ] Define what counts as required checks for a repository and how skipped Jenkins/CD stages appear to users.
- [ ] Set retry limits and specify which failure types can trigger an AI remediation attempt.
- [ ] Define what evidence is safe to attach to a PR and explicitly exclude credentials and secret values.
- [ ] Choose the initial desktop packaging/runtime approach and supported operating systems.
- [ ] Document the Jenkins connection requirements and minimum supported Jenkins/job types.

## Phase 1: Web app handoff to desktop

- [ ] Add a Jenkins feature entry point to the web app.
- [ ] Show a clear prompt that Jenkins functionality requires Bankai Desktop, with download/install links.
- [ ] Preserve the selected repository and user context across the handoff where feasible.
- [ ] Add a desktop deep link or sign-in handoff so the user can return to the same repository in the local app.
- [ ] Add install, unavailable, and unsupported-platform states.

**Done when:** a web user can discover the feature, download/open the desktop app, and land in the matching repository context.

## Phase 2: Desktop app shell and feature parity

- [x] Add an Electron desktop shell that hosts the existing Bankai web experience and reuses its backend APIs.
- [x] Reuse Bankai's existing cookie-based sign-in flow in the desktop web contents session.
- [x] Support project context handoff through the `bankai://open?project=<id>` deep link.
- [x] Add a Jenkins page in the desktop app while keeping the existing non-Jenkins routes available.
- [x] Add per-project Jenkins opt-in and opt-out states; opting out leaves scan, triage, remediation, and PR routes untouched.
- [x] Add a separate Jenkins browser window with isolated persistent cookies, HTTPS/localhost validation, and origin-restricted navigation.
- [x] Report when the Jenkins address opens successfully and show launch errors; local runner pairing/readiness is handled in the later runner integration phase.

**Done when:** users can sign in, use the same core Bankai workflow, and open Jenkins in the desktop browser with clear launch status. Runner pairing/readiness remains for the runner integration phase.

## Phase 3: Jenkins connection and job selection

- [ ] Create a guided setup form for Jenkins URL, username, and required credential/token.
- [ ] Validate inputs and test the connection immediately; provide actionable errors for unreachable server, invalid credentials, and insufficient permissions.
- [ ] Store credentials in the operating system's secure credential store; never persist them in plain text, source files, logs, or PR evidence.
- [ ] Support credential update, disconnect, and reconnect.
- [ ] Discover and list available Jenkins jobs/pipelines after connection.
- [ ] Let the user choose the build job for each repository and save that association.
- [ ] Add a connection status indicator and explain what happens while the desktop app or Jenkins is offline.
- [ ] Trigger a safe test/build run and display queued, running, passed, and failed states.
- [ ] Capture build ID, commit SHA, timing, result, and Jenkins URL for later evidence.

**Done when:** a user can enter credentials, connect, choose a job, run a build, and see the result without manually configuring Bankai internals.

## Phase 4: Jenkinsfile detection and proposal

- [ ] Detect `Jenkinsfile` in the repository's relevant branch.
- [ ] If found, show its path and associate the repository with a Jenkins job that uses it.
- [ ] If missing, inspect manifests, languages, build tools, test scripts, and existing CI files.
- [ ] Generate a starter Jenkinsfile from detected commands and stages; call out uncertain or unsupported assumptions.
- [ ] Validate the draft for basic declarative pipeline syntax and verify referenced files/commands exist where practical.
- [ ] Show the complete proposed Jenkinsfile plus a plain-language stage summary in the desktop app.
- [ ] Let the user edit, accept for a PR, or skip.
- [ ] Create/update a PR with the Jenkinsfile only after the user accepts; do not add secrets or guessed deployment settings.
- [ ] Run the new pipeline against the PR branch and surface errors for correction.

**Done when:** missing Jenkinsfiles result in a reviewable, repository-specific proposal and user-controlled PR.

## Phase 5: Connect pipeline to remediation workflow

- [ ] Trigger Jenkins on the proposed remediation branch/PR commit.
- [ ] Associate every build with repository, PR, commit SHA, remediation task, and pipeline run ID.
- [ ] Report pipeline state in the Bankai PR/remediation view and (where supported) as a GitHub check.
- [ ] Retrieve and summarize failure output while redacting secrets and limiting retained log content.
- [ ] On an eligible failure, send the failure context to the remediation agent and request a targeted fix.
- [ ] Create a new commit/update the PR and rerun the required checks, bounded by the retry policy.
- [ ] Stop and mark `needs_review` for exhausted retries, ambiguous failures, or failures requiring environment/credential changes.
- [ ] Ensure a user can cancel a running pipeline/retry where supported.

**Done when:** a remediation PR receives a build result, eligible failures can be retried safely, and unresolved failures return to a person with useful context.

## Phase 6: Simple CD through an existing Jenkins deployment job

- [ ] Discover deployment jobs from the connected Jenkins instance or allow the user to select one by name.
- [ ] Let the user enable/disable CD per repository and select the deployment job; do not require a separate provider integration for v1.
- [ ] Explain that the selected Jenkins job defines the destination and deployment procedure.
- [ ] Do not infer a deployment destination or add deployment credentials to the repository.
- [ ] Configure deployment to run only after the required build/security checks pass.
- [ ] Confirm whether the chosen Jenkins job supports safe parameterized invocation; expose required non-secret parameters in a clear setup flow.
- [ ] Trigger deployment and show queued/running/succeeded/failed states, build number, logs link, and target link if Jenkins provides one.
- [ ] If no deployment job is configured, mark CD as `not_configured` and provide a simple selection/setup path.
- [ ] Keep the initial CD behavior to the selected existing Jenkins job; defer direct provider integrations.

**Done when:** a user can choose an existing deployment job and Bankai runs it after successful checks, showing the outcome.

## Phase 7: Evidence and user review

- [ ] Define an evidence payload containing commit SHA, Jenkins build link/result, check summary, deployment job/result, timestamps, and retry count.
- [ ] Redact secrets and exclude raw credentials, tokens, and sensitive environment values.
- [ ] Attach evidence as a PR comment or check summary using the existing GitHub integration.
- [ ] Make evidence idempotent so retries update the summary rather than spamming duplicate comments.
- [ ] Link to detailed Jenkins logs/deployment view instead of copying sensitive logs into GitHub.
- [ ] Present final pass/failure and remaining manual action in the desktop and web PR views.
- [ ] Keep merge under the user's control; Bankai reports results but does not merge automatically in v1.

**Done when:** a reviewer can see what was scanned, built, checked, retried, and deployed, then make the merge decision.

## Phase 8: Reliability, security, and release readiness

- [ ] Add authorization checks so users can only view/run jobs for repositories and Jenkins connections they control.
- [ ] Protect credentials with OS-level secure storage and redact them from errors, telemetry, and logs.
- [ ] Handle Jenkins timeouts, restarts, rate limits, offline desktop state, duplicate webhooks, and stale job status.
- [ ] Make pipeline triggers idempotent per PR commit and configured job.
- [ ] Add audit events for connection changes, job selection, builds, retries, deployments, and evidence updates.
- [ ] Add clear recovery actions for expired credentials, unreachable Jenkins, deleted jobs, and failed deployment.
- [ ] Validate installer update/uninstall behavior and supported desktop platforms.
- [ ] Run end-to-end checks using a sample repo with and without a Jenkinsfile and with successful/failing build and deployment jobs.

**Done when:** common connection and pipeline failures are visible, recoverable, and do not falsely appear as successful.

## Suggested delivery order

1. Phase 0 contracts and boundaries.
2. Phase 2 desktop shell and authentication, alongside Phase 1 web handoff.
3. Phase 3 Jenkins connection and build job execution.
4. Phase 4 Jenkinsfile proposal and review.
5. Phase 5 remediation-to-build loop.
6. Phase 6 CD via existing Jenkins deployment job.
7. Phase 7 PR evidence.
8. Phase 8 hardening and release readiness.

## Explicitly out of the first release

- Direct AWS/Azure/GCP/Vercel/Kubernetes deployment integrations.
- Automatically inventing deployment destinations or credentials.
- Automatically merging pull requests.
- Unbounded AI retries or retries for failures requiring human/environment changes.

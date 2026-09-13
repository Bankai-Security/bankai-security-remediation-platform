# Bankai Security Engine — Build Prompts

Durable copy of the phased kickoff prompts for building **`bankai-security-engine`**,
a standalone security-analysis and remediation engine the main Bankai app will consume
over an API.

**Full architecture plan:** https://claude.ai/code/artifact/ed660baf-0bcd-492e-a20c-b203cf3ed348

## How to use
- Each prompt is self-contained — paste it into a **fresh** Claude Code session.
- Run them **in order**. Each assumes the previous phase is complete and lists what to
  carry forward so a cold session doesn't re-architect the core.
- Every prompt ends with a **confirm-first step** — the session proposes interfaces/
  contracts and waits for you before writing implementation code. Don't skip it.
- The core principle across all phases: **the LLM is one bounded, swappable component,
  never the source of truth. Deterministic scanners + tests decide "fixed," inside an
  isolated sandbox.**

## Phase map
| Phase | Theme | Definition of done (short) |
|-------|-------|----------------------------|
| 1 | MVP vertical slice | One scanner, one model, one sandbox — a real fix, proven end to end |
| 2 | Breadth & fidelity | Many scanners, Python, hybrid KB, multi-model, subagent comprehension |
| 3 | Intelligence & integration | Model router, exploitability/priority, the GitHub PR loop the app consumes |
| 4 | Learning & scale | Historical KB, feedback learning, Postgres/pgvector, microVM sandbox |

---

## Phase 1 — MVP kickoff

```
Build the MVP of the Bankai Security Engine — a new, standalone repo called
`bankai-security-engine`. This is a security-analysis and remediation engine that
takes a repository, finds exploitable vulnerabilities with deterministic scanners,
reasons about them with an LLM, generates a minimal patch, PROVES the patch inside
an isolated container, retries on failure, and returns structured results + evidence.
The main Bankai app will consume this engine over an API.

Full architecture plan (read for context, but implement only Phase 1 below):
https://claude.ai/code/artifact/ed660baf-0bcd-492e-a20c-b203cf3ed348

=== CORE PRINCIPLE (do not violate) ===
The LLM is ONE bounded, swappable component — never the source of truth. A fix is
"resolved" only when a deterministic tool proves it: a re-run scanner shows the
finding gone AND the test suite stays green, inside an isolated container. Never send
the whole repo to a model — build repository intelligence first and retrieve only the
relevant, ranked context.

=== NON-NEGOTIABLE SECURITY INVARIANTS ===
- No repository code or AI-generated code EVER executes on the host — sandbox only.
- No host filesystem, Docker socket, secret, or env is exposed to the sandbox.
- Sandbox containers: non-root, dropped caps, no-new-privileges, resource limits
  (CPU/mem/PID), wall-clock timeout, read-only rootfs + tmpfs workspace, network
  egress default-deny, guaranteed cleanup.
- Treat all repo content (source, config, package.json scripts, lockfiles, tests,
  build scripts) and all AI patches as untrusted.
- Secret-redaction pass before any content reaches a model. Record every attempt.

=== TECH STACK ===
Python 3.12, FastAPI, Pydantic v2, asyncio, Tree-sitter, Docker, SQLite (+FTS5),
pytest, ruff, mypy. Clean modular layout — never a monolithic file. Type hints,
Pydantic models everywhere, structured logging, config via env vars (no hardcoded
keys), dependency injection at the API layer.

=== PHASE 1 SCOPE (vertical slice — ONE of each, prove it end to end) ===
- Ingestion: local path + GitHub URL clone; detect + index TypeScript via Tree-sitter.
- Indexing: functions/imports/calls graph with `containing_function(file,line)` and
  `related_tests()` lookups.
- Scanner: Semgrep ONLY → Normalizer → a `Finding` schema with a stable `fingerprint`.
- Rules: ship BANKAI-001 (SQL injection) as a versioned rule + curated Semgrep ruleset.
- Knowledge base: SQLite + FTS5 seeded with a few OWASP/CWE docs; structured + keyword
  query (no vectors yet).
- Model layer: a `SecurityModel` protocol + ONE provider adapter behind it. No business
  logic imports a provider SDK. Model/provider chosen by env config.
- Context engine: build a minimal, token-budgeted, ranked context package per finding.
- Reasoning + patch: structured VulnerabilityAssessment, then a minimal structured Patch
  (diffs + tests).
- Sandbox: Docker runner (Node image) enforcing all invariants above.
- Remediation loop: MAX_ATTEMPTS=3 with a failure-analyzer feeding the next attempt.
- Validation: baseline run first (record finding PRESENT + tests PASS), then differential
  Semgrep re-scan (fingerprint gone) + `npm test`. ADD two gates: (1) deterministic
  pre-sandbox patch safety checks (no new network calls, no deleted tests, no embedded
  secret, bounded diff size); (2) an executable proof-of-vulnerability test that fails
  before the patch and passes after.
- Surfaces: `POST /remediations/run` + `GET /jobs/{id}` (async jobs, return job_id);
  CLI `bankai fix ./repo --finding BANKAI-001`.
- Foundation: structured logging, token/cost capture, SQLite persistence via repository
  interfaces (Postgres-swappable later), one example vulnerable TS repo in /examples,
  unit tests + one integration test, Dockerfiles, and a CI workflow (ruff + mypy + pytest).

=== DEFAULT DECISIONS (confirm with me early, then proceed) ===
- Queue: in-process asyncio worker for MVP (Redis later — main app already uses it).
- Model provider: use whichever real API key I can provide — ask me which one before
  wiring the adapter; keep the adapter isolated so it's swappable.
- Sandbox host: assume local Docker for dev; flag prod sandbox hosting as an open issue.
- App contract: REST for now; a generated TS client comes later.

=== DEFINITION OF DONE ===
On the seeded vulnerable TS repo, `bankai fix` (and `POST /remediations/run`) produces
a patch that makes Semgrep's BANKAI-001 finding disappear AND keeps `npm test` green,
entirely inside the sandbox, with a recorded evidence bundle (before/after scan,
exploit test, diff).

=== BUILD ORDER (prove the riskiest thing first) ===
1) Plan the repo structure and confirm the default decisions with me.
2) Shared Pydantic schemas (the contracts).
3) Ingestion.
4) Semgrep scanner + normalizer.
5) Docker sandbox skeleton — PROVE isolation early with a throwaway test.
6) Indexing + context engine.
7) Model adapter.
8) Patch generation.
9) Remediation loop.
10) Validator (differential scan + tests + the two added gates).
11) API + CLI + example repo + tests + CI.

Start with step 1: propose the repo structure and the interfaces for SecurityModel,
Scanner, Finding, Patch, and the sandbox runner, and confirm the default decisions —
before writing implementation code.
```

---

## Phase 2 — Breadth & fidelity

```
Extend the Bankai Security Engine to Phase 2. The Phase 1 MVP is complete: local/GitHub
ingestion, TypeScript indexing, a single Semgrep scanner → normalized Finding with
fingerprint, a SQLite+FTS5 knowledge base, one SecurityModel adapter, a context engine,
patch generation, a Docker sandbox enforcing all isolation invariants, a MAX_ATTEMPTS=3
remediation loop, and validation (differential re-scan + npm test + proof-of-vuln test +
pre-sandbox safety gates), exposed via POST /remediations/run, GET /jobs/{id}, and the CLI.

Full architecture plan (read for context; implement only Phase 2 below):
https://claude.ai/code/artifact/ed660baf-0bcd-492e-a20c-b203cf3ed348

=== CARRY FORWARD (do not regress) ===
- The LLM is never the source of truth — deterministic scanners + tests decide "fixed."
- All non-negotiable security invariants from Phase 1 stay in force: no host execution,
  no host FS/socket/secret exposure, egress default-deny, non-root sandbox with resource
  limits + cleanup, secret redaction before any model call, every attempt recorded.
- Never send the whole repo to a model; retrieve minimal, ranked context.
- Keep the modular layout, type hints, Pydantic contracts, structured logging, DI,
  and provider-SDK isolation. Extend interfaces; don't rewrite the core.

=== PHASE 2 SCOPE — breadth & fidelity ===
1) Multi-scanner: add Trivy, Gitleaks, OSV, npm-audit, pip-audit, and Bandit behind the
   existing Scanner protocol. Each runs in isolation. Extend the Normalizer to merge and
   DEDUPE findings across scanners on fingerprint (same issue from two tools = one Finding
   with combined provenance). Confidence should rise when multiple scanners agree.
2) Full RepoGraph: extend indexing to classes, exports, and a cross-file call graph
   (callers/callees across modules). Add the Python Tree-sitter parser so the engine
   handles Python repos, not just TypeScript. Keep the parser layer extensible for more
   languages later.
3) Knowledge base upgrade: add vector rerank via sqlite-vec on top of the existing
   structured + FTS hybrid retrieval (structured filter → keyword → vector rerank — do
   not replace keyword search with pure vectors). Build real ingestion pipelines for
   OWASP, CWE, and CVE/NVD data instead of the hand-seeded MVP docs.
4) Multi-model: implement a second and third provider adapter behind SecurityModel,
   selectable by config. ADD an independent-review step — a DIFFERENT model reviews the
   generator's patch before validation (the reviewer must be a distinct provider/model
   from the generator). Keep routing simple/config-driven; do not build the smart router
   yet (that's Phase 3).
5) Subagent comprehension (gated for large repos only — small repos keep the single-pass
   context engine): build the Comprehension Orchestrator with a size gate, a Module
   Summarizer subagent, and a Dependency Auditor subagent. Partition along the graph
   (modules/packages/call clusters), never arbitrary line chunks. Persist results in a
   Repo Understanding Store that refreshes incrementally. Enforce hard caps on
   concurrency, fan-out depth (no infinite child-spawning), per-subagent token/time
   budget, and a global fan-out ceiling. Run secret redaction BEFORE partitioning.
6) Added features: (a) net-negative security delta — a patch is only accepted if the
   full post-patch scan introduces NO new findings, not just the target fingerprint gone;
   (b) incremental caching — cache scan and comprehension results keyed on file hashes so
   re-scans are cheap; (c) a cost governor — per-job token/dollar budget with a hard stop.

=== OBSERVABILITY ===
Surface per-scanner timing, per-subagent token/cost, cache hit rates, and total per-job
spend as structured metrics (Prometheus-compatible shape).

=== DEFINITION OF DONE ===
- A Python repo and a TypeScript repo both run end to end.
- Two scanners flagging the same issue collapse into one Finding with merged provenance.
- KB queries return results ranked by structured+keyword+vector hybrid retrieval.
- A generator model's patch is reviewed by a different model before validation.
- A large repo triggers subagent comprehension within its budget caps; a small one does not.
- A patch that resolves the target but introduces a new finding is REJECTED.
- Re-scanning an unchanged repo is served largely from cache.
- All Phase 1 tests still pass; new unit + integration tests cover the above.

=== BUILD ORDER ===
1) Confirm the scanner-merge/dedupe semantics and the fingerprint-collision rules with me.
2) Multi-scanner + normalizer merge.
3) Full RepoGraph + Python parser.
4) KB vector rerank + real OWASP/CWE/CVE ingestion.
5) Second/third model adapters + independent patch review.
6) Comprehension Orchestrator + the two subagents + Repo Understanding Store (with caps).
7) Net-negative delta + caching + cost governor.
8) Metrics + tests.

Start with step 1: propose the cross-scanner dedupe/merge model and the updated Finding
provenance shape, and confirm with me before implementing.
```

---

## Phase 3 — Intelligence & integration

```
Extend the Bankai Security Engine to Phase 3. Phases 1–2 are complete: multi-scanner
ingestion with cross-scanner dedupe on fingerprint, full RepoGraph (classes/exports/
cross-file call graph) for TypeScript and Python, a hybrid KB (structured + keyword +
vector) with real OWASP/CWE/CVE ingestion, multiple model providers behind SecurityModel
with independent patch review, a gated subagent comprehension layer (Module Summarizer +
Dependency Auditor + Repo Understanding Store), net-negative-delta validation, incremental
caching, and a cost governor — all behind POST /remediations/run, GET /jobs/{id}, and the CLI.

Full architecture plan (read for context; implement only Phase 3 below):
https://claude.ai/code/artifact/ed660baf-0bcd-492e-a20c-b203cf3ed348

=== CARRY FORWARD (do not regress) ===
- The LLM is never the source of truth — deterministic scanners + tests decide "fixed."
- All Phase 1 security invariants stay in force: no host execution, no host FS/socket/
  secret exposure, egress default-deny, non-root sandbox with resource limits + cleanup,
  secret redaction before any model/subagent call, every attempt and subagent recorded.
- Never send the whole repo to a model; retrieve minimal, ranked context.
- Extend interfaces; do not rewrite the core. Keep provider-SDK isolation, subagent
  fan-out caps, and the cost governor intact.

=== PHASE 3 SCOPE — intelligence & integration ===
1) Model router: replace the config-only model selection with a task→model router that
   picks by cost/capability per task type (classification/triage → cheap; vulnerability
   reasoning → strong; patch generation → coding model; patch review → a DIFFERENT model
   than the generator; failure analysis → reasoning model). Include fallbacks on provider
   error/timeout. Keep it declarative and simple — no ML-based routing.
2) Exploitability & reachability: add the Dataflow Tracer and Auth/Boundary Mapper
   subagents (taint sources→sinks across module boundaries; where authn/authz and trust
   boundaries sit). Feed these into the Vulnerability Engine so it produces an
   `exploitability` judgment and a `reachable` flag, and compute a `priority_score` per
   finding. Findings are triaged and remediated in priority order. Expose priority_score
   in the Finding/result schemas (the main app will sort on it).
3) Autonomous loop hardening: add confidence-based early stopping (abort attempts when
   confidence drops below a threshold), explicit safety trips (e.g. patch keeps failing
   the same gate, blast radius too large, budget exhausted), and per-attempt evidence
   diffs so each attempt's before/after is inspectable. Never allow an unbounded loop.
4) GitHub PR integration (the main deliverable): open a PR from a validated remediation
   with the full evidence bundle in the description — before/after scan, the passing
   proof-of-vulnerability test, the diff, and the attestation. This REPLACES the main
   Bankai app's Gemini fix-pr / fix-retry path; design the request/response contract so
   the app can call the engine and receive a PR URL + structured result. GitHub creds are
   passed in per-request/config — never hardcoded, never exposed to the sandbox.
5) Added features:
   (a) Adversarial red-team subagent — plays attacker against the PROPOSED fix, trying to
       bypass it (variant attacks on the same sink) BEFORE validation signs off.
   (b) Policy/guardrail engine — org-configurable rules that gate automation (e.g. "never
       auto-merge auth changes", "block patches that add dependencies", per-severity
       auto-fix thresholds). Design it to wire into the main app's org/team hierarchy;
       policy decisions are recorded on the result.
   (c) Blast-radius analysis — use the call graph to measure what the patch actually
       touches; flag high-blast-radius fixes for human review even when tests pass.
   (d) Signed attestation bundle — emit a tamper-evident evidence bundle (SLSA/in-toto
       style): what was scanned, the container image digest that ran it, before/after
       results, the exploit test. Attach it to the PR and the RemediationResult.
6) Language + scanner breadth: add Go and Java parsers; integrate CodeQL where practical
   behind the existing Scanner protocol.

=== DEFINITION OF DONE ===
- Different task types demonstrably route to different models, with a working fallback.
- Findings carry exploitability, reachable, and priority_score; remediation runs in
  priority order.
- A validated fix opens a real GitHub PR whose description contains the full evidence
  bundle + a verifiable signed attestation.
- The red-team subagent blocks a fix that passes tests but is bypassable by a variant.
- A policy ("no auto-merge for auth changes") demonstrably gates a matching remediation.
- A high-blast-radius patch is flagged for human review despite green tests.
- Go and Java repos run end to end; CodeQL findings normalize into the Finding schema.
- All Phase 1–2 tests still pass; new unit + integration tests cover the above.

=== BUILD ORDER ===
1) Confirm two contracts with me first: the engine↔main-app remediation/PR API contract,
   and the priority_score formula (how exploitability + reachability + severity combine).
2) Model router + fallbacks.
3) Dataflow Tracer + Auth/Boundary subagents → exploitability/reachable → priority_score.
4) Loop hardening (confidence stop, safety trips, per-attempt evidence diffs).
5) Red-team subagent + blast-radius analysis.
6) Policy/guardrail engine.
7) Signed attestation bundle.
8) GitHub PR integration wiring it all together.
9) Go/Java parsers + CodeQL.
10) Tests.

Start with step 1: propose the engine↔app PR/remediation API contract and the
priority_score formula, and confirm both with me before implementing.
```

---

## Phase 4 — Learning & scale

```
Extend the Bankai Security Engine to Phase 4 — the final phase. Phases 1–3 are complete:
multi-scanner ingestion with dedupe, full RepoGraph for TS/Python/Go/Java + CodeQL, a
hybrid KB, a task→model router with fallbacks, subagent comprehension (Module Summarizer,
Dependency Auditor, Dataflow Tracer, Auth/Boundary Mapper, red-team) driving exploitability/
reachability/priority_score, a hardened bounded remediation loop, a policy/guardrail engine,
blast-radius analysis, signed attestation bundles, and GitHub PR integration that the main
Bankai app consumes in place of its old Gemini fix path.

Full architecture plan (read for context; implement only Phase 4 below):
https://claude.ai/code/artifact/ed660baf-0bcd-492e-a20c-b203cf3ed348

=== CARRY FORWARD (do not regress) ===
- The LLM is never the source of truth — deterministic scanners + tests decide "fixed."
- All Phase 1 security invariants stay in force: no host execution, no host FS/socket/
  secret exposure, egress default-deny, non-root sandbox with resource limits + cleanup,
  secret redaction before any model/subagent call, every attempt and subagent recorded.
- Never send the whole repo to a model; retrieve minimal, ranked context.
- Extend interfaces; do not rewrite the core. Keep provider isolation, subagent fan-out
  caps, the cost governor, the policy engine, and the attestation pipeline intact.

=== PHASE 4 SCOPE — learning & scale ===
1) Historical remediation KB: every VALIDATED fix becomes a first-class, retrievable
   pattern in the knowledge base — vulnerability type, language/framework, the winning
   patch shape, the exploit test, and why it passed. The context engine must query these
   past fixes as a retrieval source, so similar future findings are seeded with what
   already worked. Store only sanitized patterns — never raw customer code or secrets.
2) Fix-acceptance feedback learning: capture the human signal on every PR the engine
   opens (merged as-is / edited-then-merged / rejected, plus any review comments). Feed
   it back to recalibrate per-pattern confidence and to down-rank fix shapes people
   reject. This closes the loop — the engine learns which of its fixes get accepted.
   Design the ingestion of this signal so the main app can post it back via the API.
3) Reproducible & replayable transcripts: every remediation records its full inputs,
   model + versions, seeds/temperature, retrieved context, and container image digest,
   such that any past run can be REPLAYED deterministically to the same result. Add a
   replay command/endpoint. Reproducibility is a verifiable artifact, not a log.
4) Advanced exploitability: deepen the Dataflow Tracer into taint/data-flow-informed
   analysis across the full call graph (not just per-module) to improve reachability
   accuracy and reduce false positives feeding priority_score.
5) Cross-repository & org-level learning: mine patterns across repos within an org
   (recurring vulnerability classes, shared insecure dependencies, common root causes)
   and surface org-level insight the main app's rollup can consume. Strictly respect
   tenant boundaries — no cross-org data leakage; org isolation is a security invariant.
6) Performance & production scale:
   (a) Incremental re-index — only re-parse changed files on re-scan.
   (b) Warm sandbox pools — pre-provisioned containers to cut per-attempt startup latency,
       without weakening any isolation invariant (each attempt still gets a clean env).
   (c) Storage cutover — move from SQLite to PostgreSQL + pgvector behind the existing
       repository interfaces, with a migration path. No business logic should change.
   (d) Observability — wire the existing structured metrics to Prometheus + Grafana
       dashboards (scan/model/sandbox timings, token/cost, cache hits, acceptance rates).
7) Production sandbox hardening: move the sandbox from plain Docker to a stronger boundary
   — gVisor or Firecracker microVMs — for production execution of untrusted code. Keep the
   runner interface stable so the isolation backend is swappable; local dev can stay Docker.

=== DEFINITION OF DONE ===
- A finding similar to a past validated fix is seeded with that pattern from the KB.
- A merged/edited/rejected PR signal measurably changes future confidence for that pattern.
- Any past remediation can be replayed deterministically to an identical result.
- Taint-informed reachability demonstrably reduces false positives vs. Phase 3.
- Org-level pattern mining produces insight while provably isolating tenants.
- Re-scanning a repo with one changed file re-indexes only that file.
- The engine runs on PostgreSQL + pgvector with no business-logic changes; Grafana shows
  live metrics.
- Production sandbox runs under gVisor/Firecracker with all isolation invariants intact.
- All Phase 1–3 tests still pass; new unit + integration tests cover the above.

=== BUILD ORDER ===
1) Confirm two things with me first: the past-fix pattern schema (what's stored, how it's
   sanitized) and the tenant-isolation model for cross-repo learning.
2) Historical remediation KB + wire it into the context engine as a retrieval source.
3) Fix-acceptance feedback ingestion + confidence recalibration.
4) Reproducible/replayable transcripts + replay path.
5) Taint-informed advanced exploitability.
6) Cross-repo/org pattern mining (with hard tenant isolation).
7) Performance: incremental re-index → warm pools → Postgres/pgvector cutover → Grafana.
8) Production sandbox hardening (gVisor/Firecracker) behind the stable runner interface.
9) Tests.

Start with step 1: propose the sanitized past-fix pattern schema and the tenant-isolation
model for cross-repository learning, and confirm both with me before implementing.
```

"""RemediationService: the MAX_ATTEMPTS retry loop. Given an ingested repo
and a confirmed finding, assess it once, then repeatedly generate a patch,
gate it, prove or disprove it in the sandbox, and feed failures back into
the next attempt -- until it succeeds or attempts run out.

`run_remediation_job` is the single top-level entrypoint both the API
worker and the CLI call into: it owns ingestion, discovery, and wiring up
every collaborator, so neither surface duplicates that assembly.
"""

from __future__ import annotations

from quincy.progress import report_progress

import shutil
import sqlite3
import time
from pathlib import Path
from typing import Any, Literal

from quincy.comprehension.orchestrator import ComprehensionOrchestrator
from quincy.config import Settings
from quincy.context.builder import ContextEngine
from quincy.cost.governor import CostGovernor
from quincy.embeddings.hashing_provider import HashingEmbeddingProvider
from quincy.indexing.incremental import build_index_incremental, index_db_path_for_repo
from quincy.ingestion.source import make_source
from quincy.integrations.github.create_pr import open_remediation_pr
from quincy.knowledge.fix_pattern_store import insert_pattern, open_fix_pattern_store
from quincy.knowledge.loader import embed_knowledge_base, seed_knowledge_base
from quincy.knowledge.store import open_store
from quincy.logging import get_logger
from quincy.metrics import metrics
from quincy.models.protocol import SecurityModel
from quincy.reasoning.assess import assess_finding
from quincy.reasoning.fix_pattern_extraction import build_fix_pattern
from quincy.reasoning.patch_gen import generate_patch
from quincy.reasoning.red_team import red_team_patch
from quincy.reasoning.replay import build_settings_snapshot
from quincy.reasoning.review import review_patch
from quincy.reasoning.vulnerability_engine import score_finding
from quincy.remediation.attestation import build_and_sign_attestation
from quincy.remediation.blast_radius import compute_blast_radius
from quincy.remediation.dependency_context import enrich_dependency_context
from quincy.remediation.evidence_diff import compute_diff_stat
from quincy.remediation.failure_analyzer import analyze_failure
from quincy.remediation.policy import evaluate_policy
from quincy.remediation.safety import repeated_gate_failure
from quincy.sandbox.runner import SandboxRunner, resolve_image_digest
from quincy.scanners.base import ScanConfig, Scanner
from quincy.scanners.cache import (
    cache_db_path_for_repo,
    open_cache,
    run_all_scanners_cached,
)
from quincy.schemas.assessment import FailureAnalysis, PatchReview
from quincy.schemas.bankai import (
    BankaiContext,
    BankaiExecutionOptions,
    BankaiFindingContext,
)
from quincy.schemas.evidence import (
    AttemptEvidence,
    EvidenceBundle,
    GateResult,
    RedTeamResult,
    ValidationResult,
)
from quincy.schemas.finding import Finding, FindingKind, Location, Severity
from quincy.schemas.github import GitHubPRConfig
from quincy.schemas.model import ModelResult, TokenUsage
from quincy.schemas.patch import Patch
from quincy.schemas.policy import PolicyContext
from quincy.schemas.repo import RepoRef
from quincy.schemas.transcript import (
    ModelCallRecord,
    ModelCallType,
    RemediationTranscript,
)
from quincy.validation.baseline import run_baseline
from quincy.validation.differential import run_differential
from quincy.validation.gates import run_gates
from quincy.validation.net_negative import compute_new_findings
from quincy.validation.patching import PatchApplyError, apply_patch, materialize_patch, read_repo_files
from quincy.validation.poc import run_proof_of_vulnerability
from quincy.validation.red_team import run_red_team
from quincy.validation.runtime import resolve_runtime

logger = get_logger(__name__)

_COST_BUDGET_ABORT_REASON = "cost governor budget exceeded"
_LOW_CONFIDENCE_ABORT_REASON = "confidence_next_attempt_succeeds dropped below min_confidence_to_retry"


def _strip_test_diffs_when_pov_not_required(patch: Patch, *, require_pov: bool) -> Patch:
    if require_pov or not patch.test_diffs:
        return patch
    return patch.model_copy(update={"test_diffs": []})


class NoMatchingFindingError(RuntimeError):
    pass


def _parse_bankai_cwe(value: str | None) -> list[str]:
    if not value:
        return []
    return [part.strip() for part in value.replace(";", ",").split(",") if part.strip()]


def _severity_from_bankai_priority(value: str | None) -> Severity:
    try:
        return Severity(value or Severity.MEDIUM.value)
    except ValueError:
        return Severity.MEDIUM


def _bankai_context_to_finding(context: BankaiFindingContext, rule_id: str, priority: str | None) -> Finding:
    file_path = context.file_path.strip()
    line_start = context.line_start or 1
    line_end = context.line_end or line_start
    package_name = (context.affected_packages or "").split(",", 1)[0].strip() or file_path
    message_parts = [
        context.description,
        context.remediation_guidance,
        f"Affected package: {context.affected_packages}" if context.affected_packages else None,
        f"Current version: {context.current_versions}" if context.current_versions else None,
        f"Fixed version: {context.fixed_versions}" if context.fixed_versions else None,
    ]
    message = "\n\n".join(part.strip() for part in message_parts if part and part.strip()) or context.title
    metadata = {
        "advisory_id": rule_id,
        "package_name": package_name,
        "installed_version": context.current_versions,
        "fixed_version": context.fixed_versions,
        "source": "bankai_context",
    }
    return Finding.build(
        rule_id=rule_id,
        rule_version="bankai-context",
        title=context.title,
        severity=_severity_from_bankai_priority(priority),
        location=Location(file=file_path, start_line=line_start, end_line=line_end),
        message=message,
        scanner="bankai-context",
        raw_scanner_id=rule_id,
        severity_as_reported=priority or "medium",
        kind=FindingKind.ADVISORY,
        cwe=_parse_bankai_cwe(context.cwe),
        advisory_id=rule_id,
        package_name=package_name,
        metadata={key: value for key, value in metadata.items() if value is not None},
    )


class RemediationService:
    """The core loop: given a repo already on disk and one confirmed
    finding, prove-or-fix it. Ingestion/discovery live in
    `run_remediation_job`, not here, so this stays testable without a
    network call or a live scanner."""

    def __init__(
        self,
        scanners: list[Scanner],
        scan_configs: dict[str, ScanConfig],
        default_scan_config: ScanConfig,
        sandbox: SandboxRunner,
        model: SecurityModel,
        context_engine: ContextEngine,
        settings: Settings,
        reviewer: SecurityModel | None = None,
        cost_governor: CostGovernor | None = None,
        scan_cache_conn: sqlite3.Connection | None = None,
        symbol_conn: sqlite3.Connection | None = None,
        policy_context: PolicyContext | None = None,
        repo_ref: RepoRef | None = None,
        github_config: GitHubPRConfig | None = None,
        fix_pattern_conn: sqlite3.Connection | None = None,
        commit_sha: str | None = None,
        execution_options: BankaiExecutionOptions | None = None,
    ) -> None:
        self._scanners = scanners
        self._scan_configs = scan_configs
        self._default_scan_config = default_scan_config
        self._sandbox = sandbox
        self._model = model
        self._context_engine = context_engine
        self._settings = settings
        self._reviewer = reviewer
        self._cost_governor = cost_governor
        self._scan_cache_conn = scan_cache_conn
        self._symbol_conn = symbol_conn
        self._policy_context = policy_context or PolicyContext()
        self._repo_ref = repo_ref
        self._github_config = github_config
        self._fix_pattern_conn = fix_pattern_conn
        self._commit_sha = commit_sha
        self._execution_options = execution_options

    async def remediate(self, repo_root: Path, finding: Finding, job_id: str) -> EvidenceBundle:
        self._settings = resolve_runtime(self._settings, repo_root, finding.location.file)
        await report_progress("Running baseline scan and tests")
        baseline = await run_baseline(
            repo_root,
            finding,
            self._scanners,
            self._scan_configs,
            self._default_scan_config,
            self._sandbox,
            self._settings,
            cache_conn=self._scan_cache_conn,
        )

        baseline_output = (baseline.tests.stdout + "\n" + baseline.tests.stderr).lower()
        if not baseline.tests.passed and (
            baseline.tests.exit_code in {126, 127}
            or any(message in baseline_output for message in (
                "command not found", "executable file not found", "modulenotfounderror",
                "failed to import test module", "enoent",
            ))
        ):
            return EvidenceBundle(
                job_id=job_id, finding=finding, baseline=baseline, attempts=[], final_status="failed",
                abort_reason=f"Validation runtime unavailable: image={self._settings.sandbox_image}, "
                f"command={self._settings.test_command!r}. Provision the required runtime and dependencies; "
                "do not change application code to repair the harness. " + baseline.tests.stderr[-1500:],
            )

        if self._cost_governor is not None and self._cost_governor.is_exceeded:
            logger.warning("remediation_aborted_before_start_cost_budget", job_id=job_id)
            bundle = EvidenceBundle(
                job_id=job_id,
                finding=finding,
                baseline=baseline,
                attempts=[],
                final_status="failed",
                abort_reason=_COST_BUDGET_ABORT_REASON,
            )
            metrics.record_job_completed(bundle.final_status, bundle.total_cost_usd, bundle.total_tokens)
            return bundle

        model_calls: list[ModelCallRecord] = []

        def _record_call(
            call_type: ModelCallType, attempt_number: int | None, result: ModelResult[Any], duration_seconds: float
        ) -> None:
            model_calls.append(
                ModelCallRecord(
                    call_type=call_type,
                    attempt_number=attempt_number,
                    provider=result.provider,
                    model_name=result.model_name,
                    temperature=self._settings.model_temperature,
                    seed=self._settings.model_seed,
                    usage=result.usage,
                )
            )
            metrics.record_model_call(call_type, duration_seconds)

        _call_start = time.monotonic()
        assessment_result = await assess_finding(
            self._model, self._context_engine, finding, self._settings.context_token_budget
        )
        _record_call("assess", None, assessment_result, time.monotonic() - _call_start)
        if self._cost_governor is not None:
            self._cost_governor.record(assessment_result.usage)
        assessment = assessment_result.payload

        scored_finding, scoring_usage = await score_finding(
            self._model, self._symbol_conn, finding, assessment, self._settings
        )
        if self._cost_governor is not None:
            for usage in scoring_usage:
                self._cost_governor.record(usage)

        attempts: list[AttemptEvidence] = []
        previous_failure: FailureAnalysis | None = None
        final_status: Literal["succeeded", "failed"] = "failed"
        abort_reason: str | None = None
        require_tests = True
        require_pov = True
        if self._execution_options is not None:
            require_tests = self._execution_options.require_ci_parity and not self._execution_options.ignore_test_command_failures
            require_pov = self._execution_options.require_pov
            if self._execution_options.validation_policy == "target_scanner_clean":
                require_tests = False
                require_pov = False

        for attempt_number in range(1, self._settings.max_attempts + 1):
            await report_progress("Starting patch attempt", attempt_number, len(attempts))
            if self._cost_governor is not None and self._cost_governor.is_exceeded:
                logger.warning("remediation_aborted_cost_budget", job_id=job_id, attempt_number=attempt_number)
                abort_reason = _COST_BUDGET_ABORT_REASON
                break

            if (
                previous_failure is not None
                and self._settings.min_confidence_to_retry is not None
                and previous_failure.confidence_next_attempt_succeeds < self._settings.min_confidence_to_retry
            ):
                logger.warning(
                    "remediation_aborted_low_confidence",
                    job_id=job_id,
                    attempt_number=attempt_number,
                    confidence=previous_failure.confidence_next_attempt_succeeds,
                    threshold=self._settings.min_confidence_to_retry,
                )
                abort_reason = _LOW_CONFIDENCE_ABORT_REASON
                break

            _call_start = time.monotonic()
            try:
                patch_result = await generate_patch(
                    self._model,
                    self._context_engine,
                    finding,
                    assessment,
                    self._settings.context_token_budget,
                    previous_attempt=previous_failure,
                )
            except Exception as exc:
                abort_reason = f"Patch generation unavailable ({type(exc).__name__}): {exc}"
                logger.warning("patch_generation_unavailable", job_id=job_id, attempt_number=attempt_number,
                               error=abort_reason)
                break
            _record_call("generate_patch", attempt_number, patch_result, time.monotonic() - _call_start)
            if self._cost_governor is not None:
                self._cost_governor.record(patch_result.usage)
            patch = _strip_test_diffs_when_pov_not_required(patch_result.payload, require_pov=require_pov)
            materialization_error = None
            try:
                patch = materialize_patch(read_repo_files(repo_root), patch)
            except PatchApplyError as exc:
                materialization_error = str(exc)
            diff_stat = compute_diff_stat(patch)
            model_usage: list[TokenUsage] = [patch_result.usage]
            if attempt_number == 1:
                model_usage.insert(0, assessment_result.usage)

            await report_progress("Validating patch application and safety")
            gate_results = run_gates(patch, self._settings.max_patch_diff_lines)
            try:
                if materialization_error:
                    raise PatchApplyError(materialization_error)
                apply_patch(read_repo_files(repo_root), patch)
            except PatchApplyError as exc:
                gate_results.append(GateResult(name="patch_apply", passed=False, message=str(exc)))
            gates_passed = all(gate.passed for gate in gate_results)

            review: PatchReview | None = None
            if gates_passed and self._reviewer is not None:
                _call_start = time.monotonic()
                review_result = await review_patch(self._reviewer, finding, assessment, patch)
                _record_call("review_patch", attempt_number, review_result, time.monotonic() - _call_start)
                if self._cost_governor is not None:
                    self._cost_governor.record(review_result.usage)
                review = review_result.payload
                model_usage.append(review_result.usage)

            if gates_passed and (review is None or review.approved):
                await report_progress("Running patched scan and tests")
                differential = await run_differential(
                    repo_root,
                    finding,
                    patch,
                    self._scanners,
                    self._scan_configs,
                    self._default_scan_config,
                    self._sandbox,
                    self._settings,
                )
                pov = await run_proof_of_vulnerability(
                    repo_root, patch, self._sandbox, self._settings, differential.tests
                )
                new_findings = compute_new_findings(
                    baseline.scan.findings, differential.scan.findings, finding.fingerprint
                )

                red_team_result: RedTeamResult | None = None
                primary_ok = (
                    not differential.scan.finding_present
                    and not new_findings
                    and differential.tests.passed
                    and pov is not None
                    and pov.proves_vulnerability
                    and pov.proves_fix
                )
                if primary_ok and self._settings.red_team_enabled:
                    _call_start = time.monotonic()
                    red_team_output = await red_team_patch(self._model, finding, assessment, patch)
                    _record_call("red_team_patch", attempt_number, red_team_output, time.monotonic() - _call_start)
                    if self._cost_governor is not None:
                        self._cost_governor.record(red_team_output.usage)
                    model_usage.append(red_team_output.usage)
                    red_team_result = await run_red_team(
                        repo_root,
                        patch,
                        red_team_output.payload.variant_tests,
                        self._sandbox,
                        self._settings,
                        self._settings.red_team_max_variants,
                    )

                validation = ValidationResult(
                    gate_results=gate_results,
                    gates_passed=True,
                    review=review,
                    scan=differential.scan,
                    tests=differential.tests,
                    pov=pov,
                    new_findings=new_findings,
                    red_team=red_team_result,
                )
            else:
                validation = ValidationResult(gate_results=gate_results, gates_passed=gates_passed, review=review)

            attempt_accepted = validation.succeeded_for_policy(require_tests=require_tests, require_pov=require_pov)

            failure_analysis: FailureAnalysis | None = None
            if not attempt_accepted:
                _call_start = time.monotonic()
                # Keep full evidence, but do not ask the model to repair checks
                # that the selected policy delegates to downstream CI.
                retry_validation = validation.model_copy(update={
                    "tests": validation.tests if require_tests else None,
                    "pov": validation.pov if require_pov else None,
                    "scan": validation.scan.model_copy(update={"findings": [
                        item for item in validation.scan.findings
                        if item.fingerprint == finding.fingerprint
                        or item in validation.new_findings
                    ]}) if validation.scan else None,
                })
                patch_errors = [gate.message for gate in gate_results if gate.name == "patch_apply" and not gate.passed]
                failure_result = await analyze_failure(self._model, patch, retry_validation)
                _record_call("analyze_failure", attempt_number, failure_result, time.monotonic() - _call_start)
                if self._cost_governor is not None:
                    self._cost_governor.record(failure_result.usage)
                failure_analysis = failure_result.payload
                if patch_errors:
                    failure_analysis = failure_analysis.model_copy(update={
                        "attempt_number": attempt_number,
                        "guidance_for_next_attempt": "Patch application failed against the ORIGINAL snapshot: "
                        + "\n".join(patch_errors)
                        + "\nRegenerate narrow hunks using exact target_file context. No failed changes have been applied. "
                        "Prefix EVERY removed line with '-' and EVERY context line with a space. "
                        "Do not change project manifests or test commands to repair the validation harness.",
                        "confidence_next_attempt_succeeds": 0.5,
                    })
                previous_failure = failure_analysis
                model_usage.append(failure_result.usage)

            attempts.append(
                AttemptEvidence(
                    attempt_number=attempt_number,
                    patch=patch,
                    validation=validation,
                    failure_analysis=failure_analysis,
                    model_usage=model_usage,
                    diff_stat=diff_stat,
                    accepted=attempt_accepted,
                )
            )

            await report_progress("Patch accepted" if attempt_accepted else "Patch rejected; preparing retry", attempt_number, len(attempts))
            logger.info(
                "remediation_attempt_done",
                job_id=job_id,
                attempt_number=attempt_number,
                succeeded=attempt_accepted,
                new_findings=len(validation.new_findings),
                files_changed=diff_stat.files_changed,
                lines_added=diff_stat.lines_added,
                lines_removed=diff_stat.lines_removed,
            )

            if attempt_accepted:
                final_status = "succeeded"
                break

            trip = repeated_gate_failure(attempts, self._settings.repeated_gate_failure_trip_threshold)
            if trip is not None:
                logger.warning(
                    "remediation_aborted_repeated_gate_failure", job_id=job_id, gate=trip, attempt_number=attempt_number
                )
                abort_reason = f"safety trip: gate {trip!r} failed {self._settings.repeated_gate_failure_trip_threshold} consecutive attempts"
                break

        logger.info("remediation_done", job_id=job_id, final_status=final_status, attempts=len(attempts))

        red_team_final: RedTeamResult | None = None
        blast_radius = None
        policy_decision = None
        attestation = None
        sandbox_image_digest: str | None = None
        if model_calls:
            # Resolved once, regardless of attestation settings -- the
            # transcript needs it too, and both would otherwise trigger
            # their own redundant `docker inspect` call.
            sandbox_image_digest = await resolve_image_digest(self._settings.sandbox_image)

        successful_attempt = next((attempt for attempt in attempts if attempt.succeeded), None)
        if successful_attempt is not None:
            red_team_final = successful_attempt.validation.red_team
            if self._symbol_conn is not None:
                blast_radius = compute_blast_radius(self._symbol_conn, successful_attempt.patch, self._settings)
            policy_decision = evaluate_policy(
                scored_finding, successful_attempt.patch, blast_radius, self._policy_context, self._settings
            )
            if self._settings.attestation_enabled and self._settings.attestation_signing_key_hex:
                validation = successful_attempt.validation
                assert validation.scan is not None and validation.tests is not None  # succeeded implies both are set
                attestation = build_and_sign_attestation(
                    repo_root=repo_root,
                    job_id=job_id,
                    finding_fingerprint=scored_finding.fingerprint,
                    finding_rule_id=scored_finding.rule_id,
                    baseline=baseline,
                    differential_finding_present=validation.scan.finding_present,
                    differential_tests_passed=validation.tests.passed,
                    pov=validation.pov,
                    red_team=red_team_final,
                    sandbox_image=self._settings.sandbox_image,
                    sandbox_image_digest=sandbox_image_digest or f"unresolved:{self._settings.sandbox_image}",
                    settings=self._settings,
                )
            if (
                self._settings.historical_kb_enabled
                and self._fix_pattern_conn is not None
                and self._symbol_conn is not None
            ):
                pattern = build_fix_pattern(
                    scored_finding,
                    successful_attempt,
                    job_id,
                    self._policy_context.org_id,
                    self._symbol_conn,
                    policy_decision,
                    blast_radius.flagged_for_review if blast_radius is not None else False,
                )
                insert_pattern(self._fix_pattern_conn, pattern)

        transcript = None
        if model_calls:
            transcript = RemediationTranscript(
                job_id=job_id,
                repo_ref=self._repo_ref or RepoRef(kind="local_path", value=str(repo_root)),
                commit_sha=self._commit_sha,
                rule_id=scored_finding.rule_id,
                settings_snapshot=build_settings_snapshot(self._settings),
                sandbox_image=self._settings.sandbox_image,
                sandbox_image_digest=sandbox_image_digest,
                model_calls=model_calls,
            )

        bundle = EvidenceBundle(
            job_id=job_id,
            finding=scored_finding,
            baseline=baseline,
            attempts=attempts,
            final_status=final_status,
            abort_reason=abort_reason,
            red_team=red_team_final,
            blast_radius=blast_radius,
            policy_decision=policy_decision,
            attestation=attestation,
            transcript=transcript,
        )

        if successful_attempt is not None and self._github_config is not None:
            if self._repo_ref is None or self._repo_ref.kind != "github_url":
                logger.warning("github_pr_skipped_not_github_repo", job_id=job_id)
            elif policy_decision is not None and policy_decision.outcome == "blocked":
                logger.warning(
                    "github_pr_skipped_policy_blocked", job_id=job_id, matched_rules=policy_decision.matched_rules
                )
            else:
                force_draft = policy_decision is not None and policy_decision.outcome == "requires_human_review"
                try:
                    pr = await open_remediation_pr(
                        repo_root,
                        self._repo_ref.value,
                        successful_attempt.patch,
                        bundle,
                        self._github_config,
                        force_draft=force_draft,
                    )
                    bundle = bundle.model_copy(update={"pr": pr})
                except Exception:  # a PR-creation failure never invalidates already-proven evidence
                    logger.exception("github_pr_creation_failed", job_id=job_id)

        metrics.record_job_completed(bundle.final_status, bundle.total_cost_usd, bundle.total_tokens)
        return bundle


async def _discover_finding(
    repo_root: Path,
    rule_id: str,
    scanners: list[Scanner],
    scan_configs: dict[str, ScanConfig],
    default_scan_config: ScanConfig,
    settings: Settings,
    cache_conn: sqlite3.Connection | None = None,
    bankai_context: BankaiContext | None = None,
) -> Finding:
    result = await run_all_scanners_cached(scanners, repo_root, scan_configs, default_scan_config, cache_conn)
    matches = [finding for finding in result.findings if finding.rule_id == rule_id]
    snapshot = bankai_context.finding if bankai_context is not None else None
    if snapshot is not None:
        # The same scanner rule can identify many unrelated locations. A Bankai
        # ticket owns one file/location, not the first occurrence in the repo.
        matches = [item for item in matches if item.location.file == snapshot.file_path.replace("\\", "/")]
        if not matches and rule_id.startswith("bankai:") and snapshot.line_start:
            cwes = set(_parse_bankai_cwe(snapshot.cwe))
            correlated = [item for item in result.findings
                          if item.location.file == snapshot.file_path.replace("\\", "/")
                          and item.location.start_line <= (snapshot.line_end or snapshot.line_start)
                          and item.location.end_line >= snapshot.line_start
                          and cwes.intersection(item.cwe)]
            # Only a unique exact-location/CWE match can replace a synthetic ID.
            if len(correlated) == 1:
                matches = correlated
        if matches:
            selected = min(matches, key=lambda item: abs(item.location.start_line - (snapshot.line_start or item.location.start_line)))
            if snapshot.remediation_guidance:
                selected = selected.model_copy(update={"message": selected.message + "\nBankai remediation guidance: " + snapshot.remediation_guidance})
            return selected
    elif matches:
        return sorted(matches, key=lambda finding: _finding_test_command_score(finding, settings), reverse=True)[0]
    if bankai_context is not None and bankai_context.finding is not None:
        logger.warning(
            "finding_discovery_using_bankai_context",
            rule_id=rule_id,
            repo_root=str(repo_root),
            file_path=bankai_context.finding.file_path,
        )
        return _bankai_context_to_finding(bankai_context.finding, rule_id, bankai_context.priority)
    raise NoMatchingFindingError(f"no finding for rule {rule_id!r} in {repo_root}")


def _finding_test_command_score(finding: Finding, settings: Settings) -> tuple[int, str]:
    """Prefer findings whose language can be exercised by the configured tests.

    A rule id can appear in multiple languages in one repo. The remediation
    loop fixes one finding, so picking a Python finding while the sandbox runs
    `npm test` makes PoV generation nearly impossible.
    """
    suffix = Path(finding.location.file).suffix
    command = " ".join(settings.test_command).lower()
    if suffix in {".ts", ".tsx", ".js", ".jsx"} and any(tool in command for tool in ("npm", "node")):
        return (2, finding.location.file)
    if suffix == ".py" and "python" in command:
        return (2, finding.location.file)
    if suffix in {".ts", ".tsx", ".js", ".jsx", ".py"}:
        return (1, finding.location.file)
    return (0, finding.location.file)


async def run_remediation_job(
    repo_ref: RepoRef,
    rule_id: str,
    job_id: str,
    settings: Settings,
    scanners: list[Scanner],
    scan_configs: dict[str, ScanConfig],
    default_scan_config: ScanConfig,
    sandbox: SandboxRunner,
    model: SecurityModel,
    reviewer: SecurityModel | None = None,
    policy_context: PolicyContext | None = None,
    github_config: GitHubPRConfig | None = None,
    execution_options: BankaiExecutionOptions | None = None,
    bankai_context: BankaiContext | None = None,
) -> EvidenceBundle:
    """Ingests the repo, indexes it, seeds a knowledge base, discovers the
    target finding, and runs the RemediationService loop -- the one
    orchestration path both `POST /remediations/run` and `bankai fix` use."""
    source = make_source(repo_ref, github_config.token if github_config else None)
    ingested = await source.ingest()
    repo_root = Path(ingested.root_path)
    try:
        cache_db_path = cache_db_path_for_repo(settings, repo_ref)
        cache_db_path.parent.mkdir(parents=True, exist_ok=True)
        scan_cache_conn = open_cache(str(cache_db_path))

        finding = await _discover_finding(
            repo_root,
            rule_id,
            scanners,
            scan_configs,
            default_scan_config,
            settings,
            cache_conn=scan_cache_conn,
            bankai_context=bankai_context,
        )

        finding = await enrich_dependency_context(repo_root, finding)

        settings.symbol_index_db_dir.mkdir(parents=True, exist_ok=True)
        symbol_index_db_path = index_db_path_for_repo(settings.symbol_index_db_dir, repo_ref)
        symbol_conn, index_stats = build_index_incremental(repo_root, str(symbol_index_db_path))
        logger.info(
            "symbol_index_built",
            files_reparsed=index_stats.files_reparsed,
            files_unchanged=index_stats.files_unchanged,
            files_removed=index_stats.files_removed,
        )
        kb_conn = open_store()
        seed_knowledge_base(kb_conn)
        embedding_provider = HashingEmbeddingProvider()
        await embed_knowledge_base(kb_conn, embedding_provider)

        org_id = policy_context.org_id if policy_context is not None else None
        fix_pattern_conn = None
        if settings.historical_kb_enabled:
            settings.historical_kb_db_path.parent.mkdir(parents=True, exist_ok=True)
            fix_pattern_conn = open_fix_pattern_store(str(settings.historical_kb_db_path))

        cost_governor = CostGovernor(
            max_cost_usd=settings.max_job_cost_usd, max_total_tokens=settings.max_job_total_tokens
        )

        comprehension_orchestrator = ComprehensionOrchestrator(settings, model, cost_governor=cost_governor)
        understanding_conn = await comprehension_orchestrator.maybe_build_understanding(
            repo_root, repo_ref, symbol_conn, ingested.file_count
        )

        context_engine = ContextEngine(
            repo_root,
            symbol_conn,
            kb_conn,
            embedding_provider=embedding_provider,
            understanding_conn=understanding_conn,
            fix_pattern_conn=fix_pattern_conn,
            org_id=org_id,
        )

        service = RemediationService(
            scanners,
            scan_configs,
            default_scan_config,
            sandbox,
            model,
            context_engine,
            settings,
            reviewer=reviewer,
            cost_governor=cost_governor,
            scan_cache_conn=scan_cache_conn,
            symbol_conn=symbol_conn,
            policy_context=policy_context,
            repo_ref=repo_ref,
            github_config=github_config,
            fix_pattern_conn=fix_pattern_conn,
            commit_sha=ingested.commit_sha,
            execution_options=execution_options,
        )
        return await service.remediate(repo_root, finding, job_id)
    finally:
        shutil.rmtree(repo_root, ignore_errors=True)

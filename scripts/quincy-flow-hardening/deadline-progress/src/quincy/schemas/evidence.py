"""The evidence bundle: everything a deterministic tool proved, for every
attempt, so a "resolved" verdict never rests on the model's say-so."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from quincy.schemas.assessment import FailureAnalysis, PatchReview
from quincy.schemas.attestation import AttestationBundle
from quincy.schemas.finding import Finding
from quincy.schemas.model import TokenUsage
from quincy.schemas.patch import Patch
from quincy.schemas.policy import PolicyDecision
from quincy.schemas.transcript import RemediationTranscript


class PullRequestResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    number: int
    head_sha: str
    state: Literal["open", "draft", "merged"]


class ScannerRunSummary(BaseModel):
    """One scanner's contribution to a multi-scanner run -- timing and
    outcome, independent of whether it found anything. A failed scanner
    (crash, missing binary, timeout) never aborts the others; it's recorded
    here instead."""

    model_config = ConfigDict(frozen=True)

    scanner: str
    duration_seconds: float = Field(ge=0.0)
    finding_count: int = Field(ge=0)
    succeeded: bool
    error: str | None = None


class ScanRunResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    scanners: list[str] = Field(description="Every scanner that contributed to this run")
    finding_present: bool = Field(description="Whether the target fingerprint was found")
    findings: list[Finding] = Field(default_factory=list)
    scanner_summaries: list[ScannerRunSummary] = Field(default_factory=list)
    ran_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    duration_seconds: float = Field(ge=0.0, description="Wall-clock time for the whole multi-scanner run")


class TestRunResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    command: list[str]
    passed: bool
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float = Field(ge=0.0)


class GateResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str
    passed: bool
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


class PoVResult(BaseModel):
    """Proof-of-vulnerability test: must fail against unpatched code (the
    exploit reproduces) and pass against the patched code."""

    model_config = ConfigDict(frozen=True)

    test_path: str
    ran_before_patch: TestRunResult
    ran_after_patch: TestRunResult | None = None

    @property
    def proves_vulnerability(self) -> bool:
        before = self.ran_before_patch
        output = (before.stdout + "\n" + before.stderr).lower()
        infrastructure_errors = (
            "modulenotfounderror", "importerror", "syntaxerror", "command not found",
            "executable file not found", "failed to import test module", "test diff did not apply",
            "ran 0 tests",
        )
        return (not before.passed and before.exit_code == 1
                and not any(error in output for error in infrastructure_errors))

    @property
    def proves_fix(self) -> bool:
        return self.ran_after_patch is not None and self.ran_after_patch.passed


class RedTeamResult(BaseModel):
    """Adversarial verification (Phase 3): variant attacks the red-team
    subagent proposed against the SPECIFIC patch, sandbox-proven exactly
    like the primary PoV -- never trusting the model's own verdict on
    whether a bypass works. `bypassed=True` rejects the attempt even when
    the primary scan/tests/PoV all passed."""

    model_config = ConfigDict(frozen=True)

    attempted_variants: int = Field(ge=0)
    bypassed: bool
    bypass_details: list[str] = Field(default_factory=list)


class BlastRadiusResult(BaseModel):
    """How much of the codebase the ACCEPTED patch actually touches,
    computed from the call graph (Phase 3) -- informational, not a gate:
    a high score flags a fix for human review even though it passed
    everything else (see remediation.blast_radius)."""

    model_config = ConfigDict(frozen=True)

    touched_files: int = Field(ge=0)
    touched_symbols: list[str] = Field(default_factory=list)
    cross_module: bool
    score: float = Field(ge=0.0)
    flagged_for_review: bool


class ValidationResult(BaseModel):
    """Outcome of validating one patch attempt: gates, then (if gates
    passed and, when configured, an independent reviewer approved) the
    in-sandbox differential scan + tests + PoV, then (if all of that
    passed) the red-team subagent's sandbox-proven bypass attempts."""

    model_config = ConfigDict(frozen=True)

    gate_results: list[GateResult] = Field(default_factory=list)
    gates_passed: bool
    review: PatchReview | None = None
    scan: ScanRunResult | None = None
    tests: TestRunResult | None = None
    pov: PoVResult | None = None
    new_findings: list[Finding] = Field(
        default_factory=list,
        description=(
            "Findings present after the patch that weren't present at baseline and aren't the "
            "target itself -- the net-negative security delta check. A patch that resolves the "
            "target but introduces something else is rejected exactly like one that doesn't fix "
            "anything."
        ),
    )
    red_team: RedTeamResult | None = None

    @property
    def succeeded(self) -> bool:
        return self.succeeded_for_policy()

    def succeeded_for_policy(self, *, require_tests: bool = True, require_pov: bool = True) -> bool:
        return (
            self.gates_passed
            and (self.review is None or self.review.approved)
            and self.scan is not None
            and not self.scan.finding_present
            and not self.new_findings
            and (not require_tests or (self.tests is not None and self.tests.passed))
            and (not require_pov or (self.pov is not None and self.pov.proves_vulnerability and self.pov.proves_fix))
            and (self.red_team is None or not self.red_team.bypassed)
        )


class BaselineEvidence(BaseModel):
    """Pre-patch control: confirms the finding is present and tests are
    green on the *unpatched* code, before any attempt is made."""

    model_config = ConfigDict(frozen=True)

    scan: ScanRunResult
    tests: TestRunResult


class DiffStat(BaseModel):
    """Computed from one attempt's patch -- how big a change it actually
    made, so an attempt's blast radius is inspectable without re-parsing
    its unified diffs by hand (see remediation.evidence_diff)."""

    model_config = ConfigDict(frozen=True)

    files_changed: int = Field(ge=0)
    lines_added: int = Field(ge=0)
    lines_removed: int = Field(ge=0)


class AttemptEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    attempt_number: int = Field(ge=1)
    patch: Patch
    validation: ValidationResult
    failure_analysis: FailureAnalysis | None = None
    model_usage: list[TokenUsage] = Field(default_factory=list)
    diff_stat: DiffStat
    accepted: bool = Field(
        default=False,
        description="True when this attempt satisfied the caller's validation policy, which may be less strict than full PoV/test proof.",
    )

    @property
    def succeeded(self) -> bool:
        return self.accepted or self.validation.succeeded

    def succeeded_for_policy(self, *, require_tests: bool = True, require_pov: bool = True) -> bool:
        return self.validation.succeeded_for_policy(require_tests=require_tests, require_pov=require_pov)


class EvidenceBundle(BaseModel):
    model_config = ConfigDict(frozen=True)

    job_id: str
    finding: Finding
    baseline: BaselineEvidence
    attempts: list[AttemptEvidence] = Field(default_factory=list)
    final_status: Literal["succeeded", "failed"]
    abort_reason: str | None = Field(
        default=None, description="Set when the job stopped early, e.g. the cost governor's budget was hit"
    )
    red_team: RedTeamResult | None = Field(
        default=None, description="From the succeeding attempt's validation, if the job succeeded and red-team ran"
    )
    policy_decision: PolicyDecision | None = Field(
        default=None, description="Evaluated once for the succeeding attempt's patch, if the job succeeded"
    )
    blast_radius: BlastRadiusResult | None = Field(
        default=None, description="Computed once for the final accepted patch, if the job succeeded"
    )
    attestation: AttestationBundle | None = Field(
        default=None,
        description="Signed once for the succeeding attempt, if the job succeeded and a signing key is configured",
    )
    pr: PullRequestResult | None = Field(
        default=None,
        description="Set when a GitHubPRConfig was provided, the job succeeded, and policy didn't block it",
    )
    transcript: RemediationTranscript | None = Field(
        default=None, description="Set whenever at least one attempt ran -- see reasoning.replay"
    )
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @property
    def final_patch(self) -> Patch | None:
        for attempt in self.attempts:
            if attempt.succeeded:
                return attempt.patch
        return None

    @property
    def total_cost_usd(self) -> float:
        return sum(usage.cost_usd for attempt in self.attempts for usage in attempt.model_usage)

    @property
    def total_tokens(self) -> int:
        return sum(usage.total_tokens for attempt in self.attempts for usage in attempt.model_usage)

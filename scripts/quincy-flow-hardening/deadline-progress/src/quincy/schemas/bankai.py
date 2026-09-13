"""Bankai platform-facing contracts.

These models keep product/platform metadata out of the remediation loop while
still carrying it through persistence, logs, and API projections.
"""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from quincy.schemas.finding import Finding
from quincy.schemas.patch import Patch
from quincy.schemas.repo import RepoRef


class BankaiWorkflowMode(StrEnum):
    SCAN_ONLY = "scan_only"
    TRIAGE_ONLY = "triage_only"
    PLAN_ONLY = "plan_only"
    FIX_ONLY = "fix_only"
    VALIDATE_PATCH = "validate_patch"
    FIX_AND_PR = "fix_and_pr"
    CAMPAIGN_RUN = "campaign_run"


class BankaiWorkflowPhase(StrEnum):
    QUEUED = "queued"
    PREPARING_REPO = "preparing_repo"
    SCANNING = "scanning"
    TRIAGING = "triaging"
    BUILDING_CONTEXT = "building_context"
    PLANNING_FIX = "planning_fix"
    GENERATING_PATCH = "generating_patch"
    VALIDATING = "validating"
    OPENING_PR = "opening_pr"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


class BankaiFindingBucket(StrEnum):
    NEW_DELTA = "New Delta"
    IN_PROGRESS = "In Progress"
    CHANGED = "Changed"
    RESOLVED = "Resolved"


class BankaiTicketStatus(StrEnum):
    TO_DO = "To Do"
    IN_PROGRESS = "In Progress"
    IN_REVIEW = "In Review"
    DONE = "Done"


class BankaiCiStatus(StrEnum):
    PENDING_SETUP = "pending_setup"
    QUEUED = "queued"
    RUNNING = "running"
    PASSED = "passed"
    FAILED = "failed"


class BankaiPipelineStageName(StrEnum):
    BUILD = "build"
    IMAGE = "image"
    DEPLOY_DEV = "deploy-dev"
    FUNCTIONAL_TEST = "functional-test"
    INTEGRATION_TEST = "integration-test"


class BankaiWorkflowTarget(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["rule_id", "finding_fingerprint", "scanner_finding", "cve", "ghsa", "cwe", "severity_filter", "auto"]
    value: str | None = None

    @property
    def rule_id_or_auto(self) -> str:
        return self.value if self.kind == "rule_id" and self.value else "auto"


class BankaiFindingContext(BaseModel):
    """Bankai's stored finding snapshot for scanner no-match recovery.

    Quincy still prefers its own fresh scanner result. This context is used
    only when a remediation request names a rule id that the latest scan no
    longer reports, but Bankai has enough ticket evidence to attempt the fix.
    """

    model_config = ConfigDict(frozen=True)

    title: str
    file_path: str
    line_start: int | None = None
    line_end: int | None = None
    cwe: str | None = None
    affected_packages: str | None = None
    current_versions: str | None = None
    fixed_versions: str | None = None
    description: str | None = None
    remediation_guidance: str | None = None


class BankaiContext(BaseModel):
    """Metadata supplied by bankai-security-remediation-platform for one job.

    The engine treats these fields as audit/correlation data. Policy inputs
    remain in PolicyContext and remediation proof remains in EvidenceBundle.
    """

    model_config = ConfigDict(frozen=True)

    external_request_id: str | None = Field(
        default=None,
        description="Caller-owned idempotency/correlation id, e.g. a remediation ticket id",
    )
    tenant_id: str | None = Field(default=None, description="Bankai tenant/account boundary")
    requested_by: str | None = Field(default=None, description="User, service, or automation that requested the job")
    source: Literal["triage", "campaign", "manual", "webhook", "api"] = "api"
    priority: Literal["low", "medium", "high", "critical"] | None = None
    labels: list[str] = Field(default_factory=list)
    callback_url: str | None = Field(
        default=None,
        description="Optional platform webhook to call after worker completion; stored only for orchestration",
    )
    idempotency_key: str | None = Field(
        default=None,
        description="Stable caller key used to dedupe workflow creation within a tenant/project scope",
    )
    finding: BankaiFindingContext | None = Field(
        default=None,
        description="Optional Bankai ticket finding snapshot used only if Quincy cannot rediscover the target rule",
    )


class BankaiExecutionOptions(BaseModel):
    """Caller policy for a workflow run. Defaults favor proof over speed."""

    model_config = ConfigDict(frozen=True)

    max_findings: int | None = Field(default=None, ge=1)
    max_prs: int | None = Field(default=None, ge=1)
    max_files_changed: int | None = Field(default=None, ge=1)
    require_pov: bool = True
    require_red_team: bool = True
    require_attestation: bool = False
    require_ci_parity: bool = False
    validation_policy: Literal["full_proof", "target_scanner_clean"] = "full_proof"
    accept_when_target_finding_removed: bool = False
    ignore_test_command_failures: bool = False
    allow_new_dependencies: bool = False
    artifact_detail: Literal["summary", "standard", "full"] = "full"


class BankaiArtifact(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal[
        "scan",
        "test",
        "pov",
        "red_team",
        "attestation",
        "transcript",
        "diff",
        "policy",
        "blast_radius",
        "sandbox",
        "failure",
    ]
    name: str
    summary: str
    available: bool = True
    uri: str | None = None
    sha256: str | None = None


class BankaiEvidenceManifest(BaseModel):
    model_config = ConfigDict(frozen=True)

    artifacts: list[BankaiArtifact] = Field(default_factory=list)
    sandbox_image: str | None = None
    sandbox_image_digest: str | None = None
    total_cost_usd: float = Field(default=0.0, ge=0.0)
    total_tokens: int = Field(default=0, ge=0)


class BankaiWorkflowResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    findings: list[Finding] = Field(default_factory=list)
    selected_finding: Finding | None = None
    remediation_plan: str | None = None
    patch: Patch | None = None
    evidence_manifest: BankaiEvidenceManifest | None = None


class BankaiPipelineStage(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: BankaiPipelineStageName
    status: BankaiCiStatus | None = None
    conclusion: Literal["success", "failure", "cancelled", "skipped"] | None = None
    evidence_url: str | None = None
    error: str | None = None


class BankaiActivityEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    phase: BankaiWorkflowPhase
    summary: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class BankaiWorkflowState(BaseModel):
    """Bankai-compatible outer state for Quincy's optimized execution path."""

    model_config = ConfigDict(frozen=True)

    mode: BankaiWorkflowMode = BankaiWorkflowMode.FIX_AND_PR
    target: BankaiWorkflowTarget = Field(default_factory=lambda: BankaiWorkflowTarget(kind="auto"))
    execution_options: BankaiExecutionOptions = Field(default_factory=BankaiExecutionOptions)
    phase: BankaiWorkflowPhase = BankaiWorkflowPhase.QUEUED
    finding_bucket: BankaiFindingBucket | None = None
    ticket_status: BankaiTicketStatus = BankaiTicketStatus.TO_DO
    ci_status: BankaiCiStatus | None = None
    ci_fix_attempt: int = Field(default=1, ge=1)
    pipeline_stages: list[BankaiPipelineStage] = Field(default_factory=list)
    branch_name: str | None = None
    pr_url: str | None = None
    verdict: Literal[
        "resolved",
        "needs_human_review",
        "blocked_by_policy",
        "validation_failed",
        "no_fix_available",
        "scanner_failed",
        "repo_unavailable",
        "budget_exceeded",
    ] | None = None
    progress_summary: str | None = None
    active_attempt: int = Field(default=0, ge=0)
    completed_attempts: int = Field(default=0, ge=0)
    activity: list[BankaiActivityEvent] = Field(default_factory=list)
    result: BankaiWorkflowResult | None = None

    @classmethod
    def initial(
        cls,
        mode: BankaiWorkflowMode,
        target: BankaiWorkflowTarget,
        execution_options: BankaiExecutionOptions | None = None,
    ) -> BankaiWorkflowState:
        return cls(
            mode=mode,
            target=target,
            execution_options=execution_options or BankaiExecutionOptions(),
            finding_bucket=BankaiFindingBucket.NEW_DELTA,
            pipeline_stages=[BankaiPipelineStage(name=name) for name in BankaiPipelineStageName],
            activity=[BankaiActivityEvent(phase=BankaiWorkflowPhase.QUEUED, summary="queued remediation workflow")],
        )

    def advance(
        self,
        phase: BankaiWorkflowPhase,
        summary: str,
        *,
        ticket_status: BankaiTicketStatus | None = None,
        ci_status: BankaiCiStatus | None = None,
        verdict: Literal[
            "resolved",
            "needs_human_review",
            "blocked_by_policy",
            "validation_failed",
            "no_fix_available",
            "scanner_failed",
            "repo_unavailable",
            "budget_exceeded",
        ]
        | None = None,
        pr_url: str | None = None,
        result: BankaiWorkflowResult | None = None,
    ) -> BankaiWorkflowState:
        return self.model_copy(
            update={
                "phase": phase,
                "ticket_status": ticket_status or self.ticket_status,
                "ci_status": ci_status if ci_status is not None else self.ci_status,
                "verdict": verdict if verdict is not None else self.verdict,
                "pr_url": pr_url if pr_url is not None else self.pr_url,
                "result": result if result is not None else self.result,
                "activity": [*self.activity, BankaiActivityEvent(phase=phase, summary=summary)],
            }
        )


class BankaiPatchSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    summary: str
    files_changed: int = Field(ge=0)
    lines_added: int = Field(ge=0)
    lines_removed: int = Field(ge=0)


class BankaiJobStatus(BaseModel):
    """Compact job projection meant for the Bankai app UI/API boundary."""

    model_config = ConfigDict(frozen=True)

    job_id: str
    external_request_id: str | None = None
    status: Literal["pending", "running", "succeeded", "failed"]
    repo_ref: RepoRef
    rule_id: str
    priority: Literal["low", "medium", "high", "critical"] | None = None
    final_status: Literal["succeeded", "failed"] | None = None
    abort_reason: str | None = None
    error: str | None = None
    failure_guidance: str | None = None
    guidance: str | None = None
    progress_summary: str | None = None
    active_attempt: int = Field(default=0, ge=0)
    updated_at: datetime | None = None
    attempts: int = Field(ge=0)
    total_cost_usd: float = Field(ge=0.0)
    total_tokens: int = Field(ge=0)
    pr_url: str | None = None
    patch: BankaiPatchSummary | None = None

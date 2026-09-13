"""In-process asyncio worker: consumes job ids off a queue, runs
run_remediation_job(), and persists the result. Redis-backed queueing can
replace this later without the routers or RemediationService changing --
they only know about JobRepository and "put a job id on the queue"."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from quincy.config import Settings
from quincy.integrations.bankai_callback import deliver_callback
from quincy.logging import get_logger
from quincy.models.factory import get_model, get_reviewer_model
from quincy.persistence.repositories.jobs import JobRepository
from quincy.progress import progress_scope
from quincy.remediation.loop import NoMatchingFindingError, run_remediation_job
from quincy.sandbox.pool import WarmSandboxPool
from quincy.sandbox.runner import DockerSandboxRunner, SandboxRunner
from quincy.scanners.base import ScanConfig
from quincy.scanners.factory import build_scanners
from quincy.schemas.bankai import (
    BankaiArtifact,
    BankaiCiStatus,
    BankaiEvidenceManifest,
    BankaiTicketStatus,
    BankaiWorkflowMode,
    BankaiWorkflowPhase,
    BankaiWorkflowResult,
)
from quincy.schemas.evidence import EvidenceBundle
from quincy.schemas.job import JobStatus
from quincy.triage.scan import run_triage_scan

logger = get_logger(__name__)


def build_evidence_manifest(evidence: EvidenceBundle) -> BankaiEvidenceManifest:
    successful_attempt = next((attempt for attempt in evidence.attempts if attempt.succeeded), None)
    artifacts: list[BankaiArtifact] = [
        BankaiArtifact(
            kind="scan",
            name="baseline scan",
            summary=f"{len(evidence.baseline.scan.findings)} finding(s), target present={evidence.baseline.scan.finding_present}",
        ),
        BankaiArtifact(
            kind="test",
            name="baseline tests",
            summary=f"passed={evidence.baseline.tests.passed}, exit={evidence.baseline.tests.exit_code}",
        ),
    ]
    if successful_attempt is not None:
        validation = successful_attempt.validation
        artifacts.extend(
            [
                BankaiArtifact(
                    kind="diff",
                    name="accepted patch diff",
                    summary=(
                        f"{successful_attempt.diff_stat.files_changed} file(s), "
                        f"+{successful_attempt.diff_stat.lines_added}/-{successful_attempt.diff_stat.lines_removed}"
                    ),
                ),
                BankaiArtifact(
                    kind="scan",
                    name="differential scan",
                    summary=(
                        "not run"
                        if validation.scan is None
                        else f"{len(validation.scan.findings)} finding(s), target present={validation.scan.finding_present}"
                    ),
                    available=validation.scan is not None,
                ),
                BankaiArtifact(
                    kind="test",
                    name="patched tests",
                    summary=(
                        "not run"
                        if validation.tests is None
                        else f"passed={validation.tests.passed}, exit={validation.tests.exit_code}"
                    ),
                    available=validation.tests is not None,
                ),
                BankaiArtifact(
                    kind="pov",
                    name="proof-of-vulnerability",
                    summary=(
                        "not run"
                        if validation.pov is None
                        else f"before_proved={validation.pov.proves_vulnerability}, after_proved={validation.pov.proves_fix}"
                    ),
                    available=validation.pov is not None,
                ),
                BankaiArtifact(
                    kind="red_team",
                    name="red-team variants",
                    summary=(
                        "not run"
                        if validation.red_team is None
                        else f"attempted={validation.red_team.attempted_variants}, bypassed={validation.red_team.bypassed}"
                    ),
                    available=validation.red_team is not None,
                ),
            ]
        )
    if evidence.policy_decision is not None:
        artifacts.append(
            BankaiArtifact(
                kind="policy",
                name="policy decision",
                summary=f"{evidence.policy_decision.outcome}: {evidence.policy_decision.reasoning}",
            )
        )
    if evidence.blast_radius is not None:
        artifacts.append(
            BankaiArtifact(
                kind="blast_radius",
                name="blast radius",
                summary=(
                    f"{evidence.blast_radius.touched_files} file(s), "
                    f"{len(evidence.blast_radius.touched_symbols)} symbol(s), score={evidence.blast_radius.score:.1f}"
                ),
            )
        )
    if evidence.attestation is not None:
        artifacts.append(
            BankaiArtifact(
                kind="attestation",
                name="signed attestation",
                summary=f"subject={evidence.attestation.subject_digest}",
            )
        )
    if evidence.transcript is not None:
        artifacts.append(
            BankaiArtifact(
                kind="transcript",
                name="model transcript",
                summary=f"{len(evidence.transcript.model_calls)} model call(s)",
            )
        )
    return BankaiEvidenceManifest(
        artifacts=artifacts,
        sandbox_image=evidence.transcript.sandbox_image if evidence.transcript is not None else None,
        sandbox_image_digest=evidence.transcript.sandbox_image_digest if evidence.transcript is not None else None,
        total_cost_usd=evidence.total_cost_usd,
        total_tokens=evidence.total_tokens,
    )


async def process_job(job_id: str, job_repo: JobRepository, settings: Settings, sandbox: SandboxRunner) -> None:
    job = await job_repo.get(job_id)
    if job is None:
        logger.error("worker_job_not_found", job_id=job_id)
        return

    logger.info(
        "worker_job_started",
        job_id=job.id,
        rule_id=job.rule_id,
        external_request_id=job.bankai_context.external_request_id if job.bankai_context else None,
        tenant_id=job.bankai_context.tenant_id if job.bankai_context else None,
    )

    job.status = JobStatus.RUNNING
    if job.workflow_state is not None:
        initial_ci_status = (
            None
            if job.workflow_state.mode in {BankaiWorkflowMode.SCAN_ONLY, BankaiWorkflowMode.TRIAGE_ONLY}
            else BankaiCiStatus.QUEUED
        )
        job.workflow_state = job.workflow_state.advance(
            BankaiWorkflowPhase.PREPARING_REPO,
            "preparing repository for optimized remediation",
            ticket_status=BankaiTicketStatus.IN_PROGRESS,
            ci_status=initial_ci_status,
        )
    job.updated_at = datetime.now(UTC)
    await job_repo.update(job)

    scanners, scan_configs = build_scanners(settings)
    default_scan_config = ScanConfig(config_paths=[], timeout_seconds=settings.scanner_timeout_seconds)
    model = get_model(settings)
    reviewer = get_reviewer_model(settings)

    try:
        if job.workflow_state is not None and job.workflow_state.mode in {
            BankaiWorkflowMode.SCAN_ONLY,
            BankaiWorkflowMode.TRIAGE_ONLY,
        }:
            job.workflow_state = job.workflow_state.advance(
                BankaiWorkflowPhase.SCANNING,
                "running optimized scanner and triage pipeline",
                ticket_status=BankaiTicketStatus.TO_DO,
                ci_status=None,
            )
            job.updated_at = datetime.now(UTC)
            await job_repo.update(job)
            findings, duration = await run_triage_scan(
                job.repo_ref,
                settings,
                scanners,
                scan_configs,
                default_scan_config,
                model,
            )
            if job.workflow_state.mode == BankaiWorkflowMode.TRIAGE_ONLY:
                phase = BankaiWorkflowPhase.TRIAGING
                summary = f"triaged {len(findings)} finding(s) in {duration:.2f}s"
            else:
                phase = BankaiWorkflowPhase.COMPLETED
                summary = f"scanned repository and found {len(findings)} finding(s) in {duration:.2f}s"
            result = BankaiWorkflowResult(findings=findings)
            job.workflow_state = job.workflow_state.advance(
                phase,
                summary,
                ticket_status=BankaiTicketStatus.TO_DO,
                result=result,
            )
            if phase != BankaiWorkflowPhase.COMPLETED:
                job.workflow_state = job.workflow_state.advance(
                    BankaiWorkflowPhase.COMPLETED,
                    "completed triage workflow",
                    ticket_status=BankaiTicketStatus.TO_DO,
                    result=result,
                )
            job.status = JobStatus.SUCCEEDED
            job.github_config = None
            job.updated_at = datetime.now(UTC)
            await job_repo.update(job)
            await deliver_callback(job, settings)
            return

        if job.workflow_state is not None:
            job.workflow_state = job.workflow_state.advance(
                BankaiWorkflowPhase.VALIDATING,
                "running scan, context, patch, sandbox validation, and evidence generation",
                ticket_status=BankaiTicketStatus.IN_PROGRESS,
                ci_status=BankaiCiStatus.RUNNING,
            )
            job.updated_at = datetime.now(UTC)
            await job_repo.update(job)
        async def persist_progress(summary: str, active: int | None, completed: int | None) -> None:
            if job.workflow_state is not None:
                state = job.workflow_state
                job.workflow_state = state.model_copy(update={
                    "progress_summary": summary,
                    "active_attempt": active if active is not None else state.active_attempt,
                    "completed_attempts": completed if completed is not None else state.completed_attempts,
                })
                job.updated_at = datetime.now(UTC)
                await job_repo.update(job)

        with progress_scope(persist_progress):
            evidence = await run_remediation_job(
                repo_ref=job.repo_ref,
                rule_id=job.rule_id,
                job_id=job.id,
                settings=settings,
                scanners=scanners,
                scan_configs=scan_configs,
                default_scan_config=default_scan_config,
                sandbox=sandbox,
                model=model,
                reviewer=reviewer,
                policy_context=job.policy_context,
                github_config=job.github_config,
                execution_options=job.workflow_state.execution_options if job.workflow_state is not None else None,
                bankai_context=job.bankai_context,
            )
        job.evidence = evidence
        job.status = JobStatus.SUCCEEDED if evidence.final_status == "succeeded" else JobStatus.FAILED
        if job.workflow_state is not None:
            final_pr_url = evidence.pr.url if evidence.pr is not None else None
            workflow_result = BankaiWorkflowResult(
                selected_finding=evidence.finding,
                patch=evidence.final_patch,
                evidence_manifest=build_evidence_manifest(evidence),
            )
            if evidence.final_status == "succeeded":
                ticket_status = BankaiTicketStatus.IN_REVIEW if final_pr_url else BankaiTicketStatus.DONE
                summary = "opened verified remediation PR" if final_pr_url else "completed verified remediation"
                job.workflow_state = job.workflow_state.advance(
                    BankaiWorkflowPhase.COMPLETED,
                    summary,
                    ticket_status=ticket_status,
                    ci_status=BankaiCiStatus.PASSED,
                    verdict="resolved",
                    pr_url=final_pr_url,
                    result=workflow_result,
                )
            else:
                if evidence.abort_reason == "cost governor budget exceeded":
                    job.workflow_state = job.workflow_state.advance(
                        BankaiWorkflowPhase.FAILED,
                        evidence.abort_reason,
                        ticket_status=BankaiTicketStatus.IN_PROGRESS,
                        ci_status=BankaiCiStatus.FAILED,
                        verdict="budget_exceeded",
                        result=workflow_result,
                    )
                else:
                    job.workflow_state = job.workflow_state.advance(
                        BankaiWorkflowPhase.FAILED,
                        evidence.abort_reason or "remediation validation failed",
                        ticket_status=BankaiTicketStatus.IN_PROGRESS,
                        ci_status=BankaiCiStatus.FAILED,
                        verdict="validation_failed",
                        result=workflow_result,
                    )
    except NoMatchingFindingError as exc:
        job.status = JobStatus.FAILED
        job.error = str(exc)
        if job.workflow_state is not None:
            job.workflow_state = job.workflow_state.advance(
                BankaiWorkflowPhase.FAILED,
                str(exc),
                ticket_status=BankaiTicketStatus.IN_PROGRESS,
                ci_status=BankaiCiStatus.FAILED,
                verdict="scanner_failed",
            )
    except Exception as exc:
        logger.exception("worker_job_failed", job_id=job_id)
        job.status = JobStatus.FAILED
        job.error = str(exc)
        if job.workflow_state is not None:
            job.workflow_state = job.workflow_state.advance(
                BankaiWorkflowPhase.FAILED,
                str(exc),
                ticket_status=BankaiTicketStatus.IN_PROGRESS,
                ci_status=BankaiCiStatus.FAILED,
                verdict="validation_failed",
            )

    # The token is only ever needed for the single run above -- drop it from
    # the persisted record now so it doesn't sit at rest in the jobs DB for
    # the lifetime of the job (GET /jobs/{id} never needs it either).
    job.github_config = None
    job.updated_at = datetime.now(UTC)
    await job_repo.update(job)
    await deliver_callback(job, settings)


async def run_worker(queue: asyncio.Queue[str], job_repo: JobRepository, settings: Settings) -> None:
    """Runs forever, one job at a time, until cancelled. Owns one
    WarmSandboxPool for its whole lifetime (Phase 4) -- prewarming
    settings.sandbox_image once up front means the very first job doesn't
    pay a cold image-pull cost inline, and every job shares the same
    already-warmed image set rather than each re-discovering it."""
    sandbox = WarmSandboxPool(DockerSandboxRunner())
    await sandbox.prewarm([settings.sandbox_image])
    while True:
        job_id = await queue.get()
        try:
            await process_job(job_id, job_repo, settings, sandbox)
        finally:
            queue.task_done()

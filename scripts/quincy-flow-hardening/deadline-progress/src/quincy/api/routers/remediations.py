"""POST /remediations/run — validates the request, persists a PENDING job,
enqueues it for the worker, and returns immediately with the job id."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from quincy.api.deps import get_job_queue, get_job_repo
from quincy.logging import get_logger
from quincy.persistence.repositories.jobs import JobRepository
from quincy.schemas.bankai import (
    BankaiContext,
    BankaiJobStatus,
    BankaiPatchSummary,
    BankaiWorkflowMode,
    BankaiWorkflowState,
    BankaiWorkflowTarget,
)
from quincy.schemas.github import GitHubPRConfig
from quincy.schemas.job import RemediationJob
from quincy.schemas.policy import PolicyContext
from quincy.schemas.repo import RepoRef

logger = get_logger(__name__)

router = APIRouter(prefix="/remediations", tags=["remediations"])


class RunRemediationRequest(BaseModel):
    repo_ref: RepoRef
    rule_id: str
    policy_context: PolicyContext | None = None
    bankai_context: BankaiContext | None = None
    github: GitHubPRConfig | None = None


class RunRemediationResponse(BaseModel):
    job_id: str


@router.post("/run", response_model=RunRemediationResponse, status_code=202)
async def run_remediation(
    body: RunRemediationRequest,
    job_repo: JobRepository = Depends(get_job_repo),
    queue: asyncio.Queue[str] = Depends(get_job_queue),
) -> RunRemediationResponse:
    job = RemediationJob(
        repo_ref=body.repo_ref,
        rule_id=body.rule_id,
        policy_context=body.policy_context,
        bankai_context=body.bankai_context,
        workflow_state=BankaiWorkflowState.initial(
            BankaiWorkflowMode.FIX_AND_PR, BankaiWorkflowTarget(kind="rule_id", value=body.rule_id)
        ),
        github_config=body.github,
    )
    await job_repo.create(job)
    await queue.put(job.id)
    logger.info(
        "remediation_job_enqueued",
        job_id=job.id,
        rule_id=job.rule_id,
        external_request_id=job.bankai_context.external_request_id if job.bankai_context else None,
        tenant_id=job.bankai_context.tenant_id if job.bankai_context else None,
    )
    return RunRemediationResponse(job_id=job.id)


@router.get("/{job_id}/bankai", response_model=BankaiJobStatus)
async def get_bankai_remediation_status(
    job_id: str,
    job_repo: JobRepository = Depends(get_job_repo),
) -> BankaiJobStatus:
    job = await job_repo.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"job {job_id!r} not found")
    return _to_bankai_status(job)


def _to_bankai_status(job: RemediationJob) -> BankaiJobStatus:
    evidence = job.evidence
    final_patch = evidence.final_patch if evidence is not None else None
    successful_attempt = next((attempt for attempt in evidence.attempts if attempt.succeeded), None) if evidence else None
    final_failure = (
        next((attempt.failure_analysis for attempt in reversed(evidence.attempts) if attempt.failure_analysis), None)
        if evidence
        else None
    )
    failure_guidance = final_failure.guidance_for_next_attempt if final_failure is not None else None
    patch_summary = None
    if final_patch is not None and successful_attempt is not None:
        patch_summary = BankaiPatchSummary(
            summary=final_patch.summary,
            files_changed=successful_attempt.diff_stat.files_changed,
            lines_added=successful_attempt.diff_stat.lines_added,
            lines_removed=successful_attempt.diff_stat.lines_removed,
        )
    bankai_context = job.bankai_context
    return BankaiJobStatus(
        job_id=job.id,
        external_request_id=bankai_context.external_request_id if bankai_context else None,
        status=job.status.value,
        repo_ref=job.repo_ref,
        rule_id=job.rule_id,
        priority=bankai_context.priority if bankai_context else None,
        final_status=evidence.final_status if evidence is not None else None,
        abort_reason=evidence.abort_reason if evidence is not None else None,
        error=job.error,
        failure_guidance=failure_guidance,
        guidance=failure_guidance,
        attempts=len(evidence.attempts) if evidence is not None else (job.workflow_state.completed_attempts if job.workflow_state else 0),
        progress_summary=job.workflow_state.progress_summary if job.workflow_state else None,
        active_attempt=job.workflow_state.active_attempt if job.workflow_state else 0,
        updated_at=job.updated_at,
        total_cost_usd=evidence.total_cost_usd if evidence is not None else 0.0,
        total_tokens=evidence.total_tokens if evidence is not None else 0,
        pr_url=evidence.pr.url if evidence is not None and evidence.pr is not None else None,
        patch=patch_summary,
    )

"""Turns a failed attempt's validation result into structured feedback the
next attempt can act on, via the model."""

from __future__ import annotations

from quincy.logging import get_logger
from quincy.models.protocol import SecurityModel
from quincy.schemas.assessment import FailureAnalysis
from quincy.schemas.evidence import ValidationResult
from quincy.schemas.model import ModelResult, TokenUsage
from quincy.schemas.patch import Patch

logger = get_logger(__name__)


async def analyze_failure(
    model: SecurityModel, patch: Patch, validation: ValidationResult
) -> ModelResult[FailureAnalysis]:
    logger.info(
        "failure_analysis_start",
        attempt_number=patch.attempt_number,
        gates_passed=validation.gates_passed,
    )
    try:
        result = await model.analyze_failure(patch, validation)
    except Exception as exc:
        logger.warning("failure_analysis_unavailable", error=type(exc).__name__)
        reasons = [gate.message for gate in validation.gate_results if not gate.passed]
        if validation.tests and not validation.tests.passed:
            test_output = "\n".join(
                part for part in (validation.tests.stdout[-6000:], validation.tests.stderr[-6000:]) if part.strip()
            )
            reasons.append("Existing tests failed:\n" + (test_output or "No test output was captured"))
        reasons.extend(f"New finding: {finding.rule_id}: {finding.message}" for finding in validation.new_findings)
        if not reasons:
            reasons.append("Validation did not prove the fix; inspect the original source and executable proof")
        return ModelResult(
            payload=FailureAnalysis(attempt_number=patch.attempt_number, failure_reasons=reasons,
                                    guidance_for_next_attempt="\n".join(reasons), confidence_next_attempt_succeeds=0.5),
            usage=TokenUsage(), provider="deterministic", model_name="validation-feedback",
        )
    logger.info(
        "failure_analysis_done",
        attempt_number=patch.attempt_number,
        guidance=result.payload.guidance_for_next_attempt,
    )
    return result

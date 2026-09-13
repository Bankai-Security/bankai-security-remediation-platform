import pytest
from quincy.remediation.failure_analyzer import analyze_failure
from quincy.schemas.evidence import TestRunResult as RunResult, ValidationResult
from quincy.schemas.patch import Patch

class BrokenModel:
    async def analyze_failure(self, patch, validation):
        raise TimeoutError

@pytest.mark.asyncio
async def test_deterministic_feedback_includes_pytest_stdout():
    patch = Patch(finding_fingerprint='f', attempt_number=1, summary='s', rationale='r')
    validation = ValidationResult(gates_passed=True, tests=RunResult(command=['pytest'], passed=False, exit_code=1, stdout='FAILED test_rejects_attack - expected ValueError', stderr='', duration_seconds=1))
    result = await analyze_failure(BrokenModel(), patch, validation)
    assert 'FAILED test_rejects_attack' in result.payload.guidance_for_next_attempt

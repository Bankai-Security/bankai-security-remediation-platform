import asyncio
import pytest
from quincy.api import worker
from quincy.api.routers.remediations import _to_bankai_status
from quincy.config import Settings
from quincy.persistence.db import open_db
from quincy.persistence.repositories.jobs import SQLiteJobRepository
from quincy.progress import report_progress, progress_scope
from quincy.schemas.bankai import BankaiWorkflowState, BankaiWorkflowMode, BankaiWorkflowTarget
from quincy.schemas.job import RemediationJob
from quincy.schemas.repo import RepoRef
from quincy.schemas.patch import FileDiff, Patch, TextEdit
from quincy.schemas.evidence import PoVResult, TestRunResult as RunResult
from quincy.validation.patching import PatchApplyError, materialize_patch

@pytest.mark.asyncio
async def test_worker_persists_progress_before_completion(monkeypatch):
    conn = await open_db(':memory:')
    repo = SQLiteJobRepository(conn)
    job = RemediationJob(repo_ref=RepoRef(kind='github_url', value='https://github.com/example/app'), rule_id='CVE-test', workflow_state=BankaiWorkflowState.initial(BankaiWorkflowMode.FIX_AND_PR, BankaiWorkflowTarget(kind='rule_id', value='CVE-test')))
    await repo.create(job)
    async def running(**kwargs):
        await report_progress('Generating patch', 2, 1)
        saved = await repo.get(job.id)
        status = _to_bankai_status(saved)
        assert status.status == 'running'
        assert status.attempts == 1
        assert status.active_attempt == 2
        assert status.progress_summary == 'Generating patch'
        assert status.updated_at > job.created_at
        raise RuntimeError('intentional stop after observing persisted progress')
    monkeypatch.setattr(worker, 'run_remediation_job', running)
    try:
        await worker.process_job(job.id, repo, Settings(_env_file=None, model_provider='fake', enabled_scanners=[]), object())
        assert (await repo.get(job.id)).status == 'failed'
    finally:
        await conn.close()

@pytest.mark.asyncio
async def test_progress_is_isolated_between_concurrent_jobs():
    seen = {'a': [], 'b': []}
    async def run(name):
        async def capture(summary, active, completed): seen[name].append(summary)
        with progress_scope(capture):
            await asyncio.sleep(0)
            await report_progress(name)
        await report_progress('outside')
    await asyncio.gather(run('a'), run('b'))
    assert seen == {'a': ['a'], 'b': ['b']}

def test_complete_existing_test_replacement_must_preserve_test_names():
    original = {'tests/test_app.py': b'def test_safe():\n    assert True\n'}
    patch = Patch(finding_fingerprint='f', attempt_number=1, summary='s', rationale='r', test_diffs=[
        FileDiff(path='tests/test_app.py', edits=[TextEdit(old_text='', new_text='def test_safe():\n    assert False\n\ndef test_rejects_attack():\n    assert True\n')])
    ])
    result = materialize_patch(original, patch)
    assert 'test_rejects_attack' in result.test_diffs[0].diff

def test_complete_existing_test_replacement_cannot_erase_tests():
    original = {'tests/test_app.py': b'def test_safe():\n    assert True\n'}
    patch = Patch(finding_fingerprint='f', attempt_number=1, summary='s', rationale='r', test_diffs=[
        FileDiff(path='tests/test_app.py', edits=[TextEdit(old_text='', new_text='def test_different():\n    assert True\n')])
    ])
    with pytest.raises(PatchApplyError, match='preserving all existing test names'):
        materialize_patch(original, patch)

def test_application_file_error_can_prove_vulnerability_when_assertions_fail():
    before = RunResult(
        command=['python', '-m', 'unittest'], passed=False, exit_code=1,
        stdout='', stderr="FileNotFoundError: [Errno 2] No such file or directory: '/reports/evil'\nFAIL: expected ValueError",
        duration_seconds=1,
    )
    assert PoVResult(test_path='tests/test_export.py', ran_before_patch=before).proves_vulnerability

@pytest.mark.parametrize('error', ['ModuleNotFoundError: app', 'SyntaxError: invalid syntax', 'test diff did not apply'])
def test_infrastructure_errors_still_do_not_prove_vulnerability(error):
    before = RunResult(command=['python'], passed=False, exit_code=1, stdout='', stderr=error, duration_seconds=1)
    assert not PoVResult(test_path='tests/test_export.py', ran_before_patch=before).proves_vulnerability

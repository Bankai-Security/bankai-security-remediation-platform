"""Task-local progress reporting, persisted by the API worker."""
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

Reporter = Callable[[str, int | None, int | None], Awaitable[None]]
_reporter: ContextVar[Reporter | None] = ContextVar("remediation_progress", default=None)

@contextmanager
def progress_scope(reporter: Reporter) -> Iterator[None]:
    token = _reporter.set(reporter)
    try:
        yield
    finally:
        _reporter.reset(token)

async def report_progress(summary: str, active_attempt: int | None = None, completed_attempts: int | None = None) -> None:
    reporter = _reporter.get()
    if reporter is not None:
        await reporter(summary, active_attempt, completed_attempts)

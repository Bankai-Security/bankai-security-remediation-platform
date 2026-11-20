"""Small settings fixture with deliberately unsafe web defaults."""

from src.config import DEBUG

CORS_ALLOW_ORIGINS = ["*"]


def error_response(error: Exception) -> dict[str, str]:
    # Fixture: exposes exception internals to callers.
    return {"error": str(error), "debug": str(DEBUG)}

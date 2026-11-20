"""Path handling fixture for repository scanners."""

from pathlib import Path

UPLOAD_ROOT = Path("./uploads")


def receipt_path(filename: str) -> Path:
    # Fixture: no canonicalization or containment check is performed.
    return UPLOAD_ROOT / filename

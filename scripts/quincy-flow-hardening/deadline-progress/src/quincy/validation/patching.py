"""Applies a model-generated unified diff to file content, and reads a
repo's files into the in-memory form the sandbox and scanner both need.

The patch is untrusted AI output, so parsing is defensive: a hunk that
doesn't parse or doesn't apply cleanly raises rather than silently
producing wrong content — a validator that "proves" a patch against the
wrong file content isn't proving anything.
"""

from __future__ import annotations

import re
import difflib
from pathlib import Path

from quincy.ingestion.detect import iter_source_files
from quincy.schemas.patch import Patch

_HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


class PatchApplyError(ValueError):
    pass


def materialize_patch(original_files: dict[str, bytes], patch: Patch) -> Patch:
    """Turn exact source edits into diffs, without asking the model to count hunks."""
    def materialize(file_diff):
        if not file_diff.edits:
            return file_diff
        # Exact edits are authoritative. Some structured-output providers emit
        # the optional legacy diff as well; never execute that redundant text.
        original = original_files.get(file_diff.path, b'').decode('utf-8').replace('\r\n', '\n')
        updated = original
        for edit in file_diff.edits:
            old = edit.old_text.replace('\r\n', '\n')
            new = edit.new_text.replace('\r\n', '\n')
            if old == '':
                if file_diff.path in original_files or updated:
                    # A model may return a complete replacement for an existing
                    # test file as a create-file edit. Accept it only when it
                    # preserves every existing test name, preventing silent
                    # deletion of coverage through an unanchored replacement.
                    from quincy.indexing.queries import is_test_file
                    test_names = set(re.findall(r"(?m)^\s*(?:async\s+)?def\s+(test_[A-Za-z0-9_]+)\s*\(", original))
                    test_names.update(re.findall(r"(?m)\b(?:it|test)\s*\(\s*['\"]([^'\"]+)['\"]", original))
                    preserves_tests = bool(test_names) and all(name in new for name in test_names)
                    if len(file_diff.edits) != 1 or not is_test_file(file_diff.path) or not preserves_tests:
                        raise PatchApplyError(
                            f"{file_diff.path}: empty old_text for an existing file requires one complete test-file replacement preserving all existing test names"
                        )
                    updated = new
                else:
                    updated = new
            else:
                if updated.count(old) != 1:
                    raise PatchApplyError(f"{file_diff.path}: old_text must match exactly once in the original source; found {updated.count(old)} matches")
                updated = updated.replace(old, new, 1)
        if updated == original:
            raise PatchApplyError(f"{file_diff.path}: edits made no changes")
        diff = ''.join(difflib.unified_diff([line + '\n' for line in original.splitlines()], [line + '\n' for line in updated.splitlines()],
                       fromfile='a/' + file_diff.path, tofile='b/' + file_diff.path))
        return file_diff.model_copy(update={'diff': diff, 'edits': []})
    from quincy.indexing.queries import is_test_file
    source = []
    tests = []
    for file_diff in patch.file_diffs:
        (tests if is_test_file(file_diff.path) else source).append(materialize(file_diff))
    tests.extend(materialize(d) for d in patch.test_diffs)
    return patch.model_copy(update={'file_diffs': source, 'test_diffs': tests})


class _Hunk:
    __slots__ = ("lines", "old_start")

    def __init__(self, old_start: int) -> None:
        self.old_start = old_start
        self.lines: list[str] = []


def _parse_hunks(diff_text: str) -> list[_Hunk]:
    hunks: list[_Hunk] = []
    current: _Hunk | None = None
    for line in diff_text.splitlines():
        if current is None and line.startswith(("--- ", "+++ ")):
            continue
        match = _HUNK_HEADER.match(line)
        if match:
            current = _Hunk(old_start=int(match.group(1)))
            hunks.append(current)
            continue
        if current is None:
            continue
        if line and line[0] in " +-":
            current.lines.append(line)
        elif line == "":
            current.lines.append(" ")
        elif line == "\\ No newline at end of file":
            continue
        else:
            raise PatchApplyError(f"invalid hunk line (missing diff prefix): {line!r}")
    return hunks


def _old_hunk_lines(hunk: _Hunk) -> list[str]:
    return [line[1:] for line in hunk.lines if line and line[0] in " -"]


def _find_hunk_start(original_lines: list[str], hunk: _Hunk, cursor: int) -> int:
    expected = _old_hunk_lines(hunk)
    if not expected:
        return max(hunk.old_start - 1, cursor)

    preferred = max(hunk.old_start - 1, cursor)
    if original_lines[preferred : preferred + len(expected)] == expected:
        return preferred

    matches = [index for index in range(cursor, len(original_lines) - len(expected) + 1)
               if original_lines[index : index + len(expected)] == expected]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise PatchApplyError("ambiguous hunk context; provide more exact surrounding lines")

    preview = expected[0] if expected else "<empty>"
    raise PatchApplyError(f"hunk context not found from line {cursor + 1}: starts with {preview!r}")


def _apply_hunks(original_text: str, hunks: list[_Hunk]) -> str:
    original_lines = original_text.splitlines()
    result: list[str] = []
    cursor = 0
    for hunk in hunks:
        start = _find_hunk_start(original_lines, hunk, cursor)
        if start > len(original_lines):
            raise PatchApplyError(f"hunk starts at line {hunk.old_start}, file has {len(original_lines)} lines")
        result.extend(original_lines[cursor:start])
        cursor = start
        for line in hunk.lines:
            tag, content = line[0], line[1:]
            if tag == " ":
                if cursor >= len(original_lines) or original_lines[cursor] != content:
                    actual = original_lines[cursor] if cursor < len(original_lines) else "<EOF>"
                    raise PatchApplyError(
                        f"context mismatch at line {cursor + 1}: expected {content!r}, found {actual!r}"
                    )
                result.append(content)
                cursor += 1
            elif tag == "-":
                if cursor >= len(original_lines) or original_lines[cursor] != content:
                    actual = original_lines[cursor] if cursor < len(original_lines) else "<EOF>"
                    raise PatchApplyError(
                        f"deletion mismatch at line {cursor + 1}: expected {content!r}, found {actual!r}"
                    )
                cursor += 1
            elif tag == "+":
                result.append(content)
    result.extend(original_lines[cursor:])
    text = "\n".join(result)
    if result:
        text += "\n"
    return text


def apply_file_diff(original_text: str, diff: str) -> str:
    hunks = _parse_hunks(diff)
    if not hunks:
        raise PatchApplyError("diff contains no recognizable hunks")
    return _apply_hunks(original_text, hunks)


def apply_patch(original_files: dict[str, bytes], patch: Patch, *, diffs: list[str] | None = None) -> dict[str, bytes]:
    """Returns a new file map with `patch`'s diffs applied on top of
    `original_files`. Pass `diffs` (a subset of paths) to apply only some of
    the patch's diffs — e.g. the proof-of-vulnerability test without the
    source fix."""
    if any(file_diff.edits for file_diff in patch.all_diffs):
        patch = materialize_patch(original_files, patch)
    patched = dict(original_files)
    target_diffs = patch.all_diffs if diffs is None else [d for d in patch.all_diffs if d.path in diffs]
    for file_diff in target_diffs:
        path = Path(file_diff.path)
        if path.is_absolute() or ".." in path.parts or "\\" in file_diff.path or ":" in file_diff.path:
            raise PatchApplyError(f"unsafe patch path: {file_diff.path!r}")
        original_bytes = patched.get(file_diff.path, b"")
        try:
            original_text = original_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PatchApplyError(f"{file_diff.path} is not valid UTF-8 text") from exc
        try:
            patched[file_diff.path] = apply_file_diff(original_text, file_diff.diff).encode("utf-8")
        except PatchApplyError as exc:
            raise PatchApplyError(f"{file_diff.path}: {exc}") from exc
    return patched


def read_repo_files(root: Path) -> dict[str, bytes]:
    """Reads every non-ignored file under `root` into an in-memory map,
    keyed by repo-relative posix path — the form both the scanner (written
    to a scratch dir) and the sandbox (staged via stdin) consume."""
    files: dict[str, bytes] = {}
    for path in iter_source_files(root):
        rel_path = path.relative_to(root).as_posix()
        files[rel_path] = path.read_bytes()
    return files

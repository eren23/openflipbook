"""_friendly_error — the SSE error frame mapping (FRIENDLY_ERRORS, default ON).

The raw exception used to reach the browser verbatim; for fal failures that
includes the ENTIRE prompt echoed back in the validation body. These pin the
mapping AND the leakage regression: prompt text never rides `message`.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pytest

sys.modules.setdefault("modal", MagicMock())

from generate import _friendly_error  # noqa: E402


class _FalLikeError(Exception):
    def __init__(self, message: str, error_type: str | None = None, status_code: int | None = None):
        super().__init__(message)
        if error_type is not None:
            self.error_type = error_type
        if status_code is not None:
            self.status_code = status_code


def test_no_media_by_error_type_attr() -> None:
    msg, detail = _friendly_error(_FalLikeError("boom", error_type="no_media_generated"))
    assert msg == "The image model declined this one — hit retry or tap somewhere else."
    assert "boom" in detail


def test_no_media_by_message_marker() -> None:
    msg, _ = _friendly_error(RuntimeError("[{'type': 'no_media_generated', ...}]"))
    assert "declined" in msg


def test_returned_no_images_marker() -> None:
    msg, _ = _friendly_error(RuntimeError("fal returned no images"))
    assert "declined" in msg


def test_timeout_class_and_wording() -> None:
    msg, _ = _friendly_error(TimeoutError("deadline"))
    assert "too long" in msg
    msg2, _ = _friendly_error(RuntimeError("request timed out after 300s"))
    assert "too long" in msg2


def test_rate_limit_by_status_and_wording() -> None:
    msg, _ = _friendly_error(_FalLikeError("slow down", status_code=429))
    assert "busy" in msg
    msg2, _ = _friendly_error(RuntimeError("openai rate limit exceeded"))
    assert "busy" in msg2


def test_safety_block() -> None:
    msg, _ = _friendly_error(RuntimeError("rejected by content_policy check"))
    assert "safety filter" in msg


def test_default_is_generic_retry() -> None:
    msg, _ = _friendly_error(ValueError("weird internal thing"))
    assert msg == "Generation failed — hit retry."


def test_detail_is_capped_at_300() -> None:
    _, detail = _friendly_error(RuntimeError("x" * 2000))
    assert len(detail) <= 300


def test_prompt_never_leaks_into_message() -> None:
    # THE regression this exists for: fal echoes the whole prompt back in the
    # error body — none of it may reach the user-facing message.
    prompt = (
        "Style: early-20th-century lithograph plate, muted pastel ink, "
        "cross-hatching, aged paper. A sprawling aerial map of a medieval "
        "fantasy city nestled in a river bend with SECRET INTERNAL WORDING."
    )
    exc = _FalLikeError(
        f"[{{'loc': ['body'], 'msg': 'bad', 'type': 'no_media_generated', "
        f"'input': {{'prompt': \"{prompt}\"}}}}]"
    )
    msg, detail = _friendly_error(exc)
    assert "lithograph" not in msg
    assert "SECRET INTERNAL WORDING" not in msg
    assert msg == "The image model declined this one — hit retry or tap somewhere else."
    assert len(detail) <= 300  # even the diagnostic tail is capped


@pytest.mark.parametrize(
    "exc",
    [RuntimeError("anything"), _FalLikeError("boom", error_type="no_media_generated")],
)
def test_always_returns_two_strings(exc: BaseException) -> None:
    msg, detail = _friendly_error(exc)
    assert isinstance(msg, str) and msg
    assert isinstance(detail, str)

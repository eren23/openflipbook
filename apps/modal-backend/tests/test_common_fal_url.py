"""providers/_common.to_fal_url — the upload memoization.

The judged loops re-render the same source across retry attempts; uploading
the full-res page once per attempt was the slow path (a measured 3.5min edit
on a hotspot). Identical bytes must upload ONCE; distinct bytes still upload;
http(s) URLs pass through untouched; the cache is bounded.
"""
from __future__ import annotations

import base64
from unittest.mock import AsyncMock

import pytest

from providers import _common


def _data_url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    _common._URL_CACHE.clear()


async def test_identical_bytes_upload_once(monkeypatch: pytest.MonkeyPatch) -> None:
    upload = AsyncMock(side_effect=lambda raw, content_type: f"https://fal/{len(raw)}")
    monkeypatch.setattr(_common.fal_client, "upload_async", upload)
    url1 = await _common.to_fal_url(_data_url(b"the-same-page-bytes"))
    url2 = await _common.to_fal_url(_data_url(b"the-same-page-bytes"))
    assert url1 == url2
    assert upload.await_count == 1  # the retry reused the upload


async def test_distinct_bytes_each_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    upload = AsyncMock(side_effect=lambda raw, content_type: f"https://fal/{raw.decode()}")
    monkeypatch.setattr(_common.fal_client, "upload_async", upload)
    a = await _common.to_fal_url(_data_url(b"page-a"))
    b = await _common.to_fal_url(_data_url(b"page-b"))
    assert a != b
    assert upload.await_count == 2


async def test_http_url_passes_through(monkeypatch: pytest.MonkeyPatch) -> None:
    upload = AsyncMock()
    monkeypatch.setattr(_common.fal_client, "upload_async", upload)
    assert await _common.to_fal_url("https://cdn/x.jpg") == "https://cdn/x.jpg"
    upload.assert_not_awaited()


async def test_cache_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_common, "_URL_CACHE_MAX", 4)
    upload = AsyncMock(side_effect=lambda raw, content_type: f"https://fal/{raw.decode()}")
    monkeypatch.setattr(_common.fal_client, "upload_async", upload)
    for i in range(10):
        await _common.to_fal_url(_data_url(f"page-{i}".encode()))
    assert len(_common._URL_CACHE) <= 4
    # The oldest (page-0) was evicted, so re-requesting it re-uploads.
    before = upload.await_count
    await _common.to_fal_url(_data_url(b"page-0"))
    assert upload.await_count == before + 1

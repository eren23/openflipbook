"""local_server.py import smoke — the module wires up generate's FastAPI app
without starting uvicorn (the run call sits behind __main__)."""

from __future__ import annotations

import importlib
import sys
from unittest.mock import MagicMock

import pytest


def test_import_exposes_the_generate_app(monkeypatch: pytest.MonkeyPatch) -> None:
    # generate.py needs modal at import time; stub it like test_deploy_safety.
    sys.modules.setdefault("modal", MagicMock())
    # local_server loads .env files at import — stub so host config stays out.
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)

    sys.modules.pop("local_server", None)
    local_server = importlib.import_module("local_server")

    from generate import fastapi_app

    assert local_server.fastapi_app is fastapi_app
    paths = {route.path for route in fastapi_app.routes}
    assert {
        "/sse/generate",
        "/animate",
        "/resolve-click",
        "/health",
        "/status",
        "/models",
    } <= paths

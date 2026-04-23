"""Run the generate.py FastAPI app locally, bypassing Modal.

Useful for iterating without deploying:

    uv venv --python 3.12
    source .venv/bin/activate
    uv pip install -r requirements.txt
    python local_server.py

Reads env from `apps/modal-backend/.env` first, then the repo root `.env` if
it exists. The Next.js app should point at this via:

    MODAL_API_URL=http://localhost:8000
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_here = Path(__file__).resolve().parent
_root = _here.parent.parent

load_dotenv(_here / ".env", override=False)
load_dotenv(_root / ".env", override=False)

for required in ("FAL_KEY", "OPENROUTER_API_KEY"):
    if not os.environ.get(required):
        print(
            f"[local_server] warning: {required} is not set; requests that need it will fail."
        )

import uvicorn  # noqa: E402
from generate import fastapi_app  # noqa: E402


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(fastapi_app, host="0.0.0.0", port=port, log_level="info")

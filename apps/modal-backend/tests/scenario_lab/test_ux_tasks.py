"""Free validation for UX bench task scripts."""
from __future__ import annotations

import json
from pathlib import Path

_TASKS = Path(__file__).resolve().parents[4] / "scripts" / "ux-bench" / "tasks"


def test_ux_tasks_well_formed() -> None:
    assert _TASKS.exists(), "ux-bench tasks dir missing"
    files = list(_TASKS.glob("*.json"))
    assert len(files) >= 5
    for path in files:
        data = json.loads(path.read_text())
        for key in ("id", "goal", "start_url", "max_steps", "success_criteria"):
            assert key in data, f"{path.name} missing {key}"

#!/usr/bin/env python3
"""Scaffold a new scenario_lab scenario from template.

    cd apps/modal-backend && .venv/bin/python -m tests.scenario_lab.scenario_new my-scene
"""
from __future__ import annotations

import json
import sys

from tests.scenario_lab import SCENARIOS_DIR

_TEMPLATE = {
    "id": "",
    "rev": 1,
    "dimensions": ["layout"],
    "requirements": {"world_mode": False, "aspect_ratio": "16:9"},
    "prompt": "Describe the scene here.",
    "expected_layout": [],
    "arms": {"fresh": {"op": "fresh", "layout_clause": False}},
    "judges": ["layout_fidelity"],
    "review": {"status": "draft", "notes": ""},
}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python -m tests.scenario_lab.scenario_new <id>")
        return 2
    sid = sys.argv[1].replace(".json", "")
    path = SCENARIOS_DIR / f"{sid}.json"
    if path.exists():
        print(f"already exists: {path}")
        return 1
    data = dict(_TEMPLATE)
    data["id"] = sid
    SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

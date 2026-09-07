import json

import pytest

from tests.continuity_bench.place_identity_runner import PilotLedger, main


def test_run_budget_survives_restart_and_daily_accounting_reset(tmp_path):
    path = tmp_path / "ledger.json"
    ledger = PilotLedger(path)
    ledger.reserve(4.60)
    resumed = PilotLedger(path)
    resumed.reserve(.20)
    with pytest.raises(RuntimeError, match="Run-wide"):
        resumed.reserve(.01)
    assert json.loads(path.read_text())["reserved_usd"] == 4.80


@pytest.mark.parametrize("amount", [float("nan"), float("inf"), -1])
def test_invalid_reservation_cannot_corrupt_ledger(tmp_path, amount):
    ledger = PilotLedger(tmp_path / "ledger.json")
    with pytest.raises(ValueError):
        ledger.reserve(amount)
    assert ledger.reserved == 0


async def test_pilot_is_opt_in_before_loading_keys(monkeypatch):
    monkeypatch.delenv("PLACE_IDENTITY_PILOT", raising=False)
    with pytest.raises(SystemExit, match="disabled"):
        await main()

"""Budget ledger — the matrix runner's hard spending gate.

`charge()` is called BEFORE each paid call (estimate → charge → call), so a
bug can overrun the cap by exactly zero calls. Estimates come from
providers/spend.py (the same table docs/COSTS.md documents); this module is
pure — no I/O, no env reads — so the refusal order is golden-testable.
"""
from __future__ import annotations

from dataclasses import dataclass


class BudgetExceeded(RuntimeError):
    """Raised BEFORE a paid call that would cross the cap."""


# One VLM judge / extraction call on gemini-flash — coarse, mirrors how
# spend.py folds the whole VLM stack into a flat $0.02 per generation.
JUDGE_CALL_FLAT = 0.005


@dataclass
class Ledger:
    cap_usd: float
    spent_usd: float = 0.0

    def charge(self, estimate_usd: float) -> None:
        """Reserve `estimate_usd` or raise — never partially mutates."""
        est = max(0.0, estimate_usd)
        if self.spent_usd + est > self.cap_usd + 1e-9:
            raise BudgetExceeded(
                f"${self.spent_usd + est:.2f} would cross the "
                f"${self.cap_usd:.2f} cap (spent ${self.spent_usd:.2f})"
            )
        self.spent_usd += est

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.cap_usd - self.spent_usd)

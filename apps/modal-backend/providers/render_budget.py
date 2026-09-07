"""A request's image limit includes transport retries and rejected outputs."""
from __future__ import annotations

import time
from dataclasses import dataclass

from providers import spend


class RenderLimitReached(RuntimeError):
    pass


@dataclass
class RenderBudget:
    session_id: str
    limit: int = 2
    deadline: float = float("inf")
    attempts: int = 0

    def remaining_seconds(self) -> float:
        return max(0.01, self.deadline - time.monotonic())

    def reserve(self, model: str) -> None:
        if self.attempts >= self.limit or time.monotonic() >= self.deadline:
            raise RenderLimitReached("The image attempt limit or deadline was reached")
        # Reserve conservatively at submission: a timeout or failed download
        # cannot prove that the provider did not bill the request.
        amount = spend.estimate_image(model)
        if self.attempts == 0:
            amount += spend.VLM_STACK_FLAT
        spend.reserve(self.session_id, amount)
        self.attempts += 1

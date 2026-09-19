"""The sites: every decision the layer knows how to put to the model.

A site names one decision point, the typed questions it asks, and the rule
that decides today (the incumbent), so every row is a paired comparison. It
also carries what a live answer may touch: a question whose "yes" spends
money or refuses a user is a spend question, and is never applied until a
human raises the site's ceiling in a reviewed diff.

The floors and verdicts the incumbent uses are deliberately NOT in any
question text or state. A model that is told "accept if at least 7" learns to
say 7; one that sees only the scores and the sentences has to read them.
"""
from __future__ import annotations

import os
import zlib
from dataclasses import dataclass, field

from .types import Mode, Question

_MODES: tuple[Mode, ...] = ("off", "shadow", "advise", "live")


@dataclass(frozen=True)
class Site:
    id: str
    questions: dict[str, Question]
    incumbent: str
    spend_questions: frozenset[str] = frozenset()
    max_mode: Mode = "live"
    threshold: float = 0.7
    state_max_chars: int = 8000
    # The incumbent's own numbers, with the env names deployments already
    # use: name -> (default, legacy env var). Read through param().
    params: dict[str, tuple[float, str]] = field(default_factory=dict)


SHIP: Question = {
    "type": "noul",
    "instructions": (
        "A render was scored by independent reviewers on several axes, 0 to 10 with 10 best, "
        "each with a one-line rationale. Should this render ship to the user as it is?"
    ),
    "criteria": {
        "true": (
            "Every axis is strong, or the shortfalls are small and cosmetic; the rationales "
            "describe a usable image of the right place from the right camera in the right medium."
        ),
        "false": (
            "A rationale names a failure a viewer would notice: the wrong camera or projection, "
            "a different place, a changed art medium, a sealed or empty interior, missing detail, "
            "or a wider view where a closer one was asked for."
        ),
    },
}

RETRY_WORTH_IT: Question = {
    "type": "noul",
    "instructions": (
        "If this render does not ship: would ONE more attempt, carrying the reviewers' rationales "
        "as feedback, plausibly fix the named failures?"
    ),
    "criteria": {
        "true": (
            "The failures are about framing, camera, medium, or detail: things an instruction can correct "
            "while the source stays the same."
        ),
        "false": (
            "The failure is structural: the source region is water, sky, a bare icon, or text with nothing "
            "behind it; the subject is not in the source; every axis failed at once; or the reviewers "
            "contradict each other."
        ),
    },
}

ASK_USER: Question = {
    "type": "noul",
    "instructions": (
        "From what the classifier read at the tapped point, would two careful users disagree about "
        "what should be entered here, so that one short clarifying question is worth asking before "
        "a paid render?"
    ),
    "criteria": {
        "true": (
            "Several plausible referents; the subject is vague or generic; the classifier proposed "
            "clarifiers of its own; or a specific subject with low confidence."
        ),
        "false": "One obvious reading; a careful colleague would proceed without asking.",
    },
}

WORTH_GENERATING: Question = {
    "type": "noul",
    "instructions": "Is there something at this tapped point worth a paid render at all?",
    "criteria": {
        "true": "A nameable place, structure, region, or object a user plausibly wants to see closer.",
        "false": (
            "Empty water or sky, a blank margin, a decorative border, a compass rose or legend, "
            "or bare text with nothing drawn behind it."
        ),
    },
}

ENTER_AS: Question = {
    "type": "choice",
    "instructions": "How should the product travel into what was tapped?",
    "criteria": {
        "scene": "Arrive at eye level or a low oblique in front of one specific place or structure.",
        "submap": "Zoom into a wider region and show it as a map again, still from above.",
        "explainer": "Nothing to travel into; describe what this is instead.",
    },
}

SITES: dict[str, Site] = {
    "render.accept": Site(
        id="render.accept",
        questions={"accept": SHIP, "retry_worth_it": RETRY_WORTH_IT},
        incumbent="render_loop._is_accepted: every wired axis at or above its floor; retry while attempts and the deadline allow",
        spend_questions=frozenset({"retry_worth_it"}),
        params={
            "accept_conformance": (7.0, "VIEW_LOOP_ACCEPT_CONFORMANCE"),
            "accept_same_place": (6.0, "VIEW_LOOP_ACCEPT_SAME_PLACE"),
            "accept_detail": (6.0, "VIEW_LOOP_ACCEPT_DETAIL"),
            "accept_medium": (6.0, "VIEW_LOOP_ACCEPT_MEDIUM"),
            "accept_interior": (6.0, "INTERIOR_ACCEPT"),
            "retry_budget_s": (240.0, "VIEW_LOOP_RETRY_BUDGET_S"),
        },
    ),
    "zoom.accept": Site(
        id="zoom.accept",
        questions={"accept": SHIP, "retry_worth_it": RETRY_WORTH_IT},
        incumbent="tap._judged_zoom._accepted: step_in and legibility at or above their floors; one retry when 45 s remain",
        spend_questions=frozenset({"retry_worth_it"}),
        # Observe-only: the zoom's call site reads the verdict for the log
        # and nothing else. Promoting it would buy a blocking round trip and
        # an answer nobody applies -- and the report would read that as the
        # model never clearing the bar. Raise this WITH the seam, not before.
        max_mode="advise",
        params={"accept": (6.0, "TAP_ZOOM_ACCEPT"), "detail_accept": (6.0, "TAP_ZOOM_DETAIL_ACCEPT")},
    ),
    "click.classify": Site(
        id="click.classify",
        questions={"ask_user": ASK_USER, "worth_generating": WORTH_GENERATING, "enter_as": ENTER_AS},
        incumbent="the click classifier's own groundable / enter_as fields; clarifiers are never asked in-band (autonomy=auto)",
        spend_questions=frozenset({"worth_generating"}),
        max_mode="advise",
    ),
}


def env_float(name: str, default: float) -> float:
    """A float env var, `default` when unset or garbage. The one parser."""
    try:
        return float(os.environ.get(name, ""))
    except ValueError:
        return default


def param(site_id: str, name: str) -> float:
    """An incumbent's number, read under the env name deployments already set."""
    default, env_name = SITES[site_id].params[name]
    return env_float(env_name, default)


def mode(site_id: str) -> Mode:
    """DECISION_MODE=off|shadow sets the floor; DECISION_LIVE lists the sites
    allowed above it; the site's own ceiling caps the result."""
    site = SITES.get(site_id)
    base = os.environ.get("DECISION_MODE", "off").strip().lower()
    if site is None or base not in ("shadow", "off"):
        return "off"
    if base == "off":
        return "off"
    live = {s.strip() for s in os.environ.get("DECISION_LIVE", "").split(",") if s.strip()}
    wanted: Mode = "live" if site_id in live else "shadow"
    return wanted if _MODES.index(wanted) <= _MODES.index(site.max_mode) else site.max_mode


def threshold(site_id: str) -> float:
    """Top probability a live answer needs before it is applied."""
    site = SITES[site_id]
    return env_float("DECISION_THRESHOLD_" + site_id.upper().replace(".", "_"), site.threshold)


def in_canary(session_id: str | None) -> bool:
    """DECISIONS_CANARY=0.10 applies live answers to a tenth of sessions,
    bucketed by session id; unset means every session. No session id means
    the call is not in a user session, and the live answer applies."""
    share = env_float("DECISIONS_CANARY", 1.0)
    if share >= 1.0 or session_id is None:
        return True
    return (zlib.crc32(session_id.encode()) % 100) < int(share * 100)

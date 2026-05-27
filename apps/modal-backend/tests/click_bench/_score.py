"""Phrase similarity scoring for the click bench.

v1 uses cheap string-similarity heuristics so the bench runs without
extra ML deps. v2 can swap in embedding cosine (sentence-transformers,
OpenAI ada, or any small open model) behind the same interface.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

_STOPWORDS = frozenset(
    {"the", "a", "an", "of", "and", "in", "on", "at", "to", "with", "for"}
)
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize(phrase: str) -> str:
    """Lowercase, strip punctuation, drop articles + small stop words."""
    s = _PUNCT_RE.sub(" ", phrase.lower()).strip()
    tokens = [t for t in s.split() if t and t not in _STOPWORDS]
    return " ".join(tokens)


def token_set(phrase: str) -> set[str]:
    return set(normalize(phrase).split())


@dataclass(frozen=True)
class PhraseScore:
    exact: bool
    fuzzy: float
    jaccard: float
    composite: float
    matched_against: str

    def passed(self, threshold: float = 0.6) -> bool:
        return self.composite >= threshold


def _score_one(predicted_norm: str, expected_norm: str) -> tuple[float, float]:
    fuzzy = SequenceMatcher(None, predicted_norm, expected_norm).ratio()
    p_tokens = set(predicted_norm.split())
    e_tokens = set(expected_norm.split())
    if not p_tokens and not e_tokens:
        jaccard = 1.0
    elif not p_tokens or not e_tokens:
        jaccard = 0.0
    else:
        jaccard = len(p_tokens & e_tokens) / len(p_tokens | e_tokens)
    return fuzzy, jaccard


def score_subject(
    predicted: str,
    expected: str,
    alternates: list[str] | None = None,
) -> PhraseScore:
    """Score a predicted subject phrase against an expected + alternates.

    Best score wins. Composite is 0.6 * fuzzy + 0.4 * jaccard — fuzzy
    handles spelling/inflection drift, jaccard handles reorderings and
    missing function words.
    """
    predicted_norm = normalize(predicted)
    candidates = [expected, *(alternates or [])]

    best_fuzzy = 0.0
    best_jaccard = 0.0
    best_match = expected
    best_exact = False

    for cand in candidates:
        cand_norm = normalize(cand)
        if not cand_norm:
            continue
        if predicted_norm == cand_norm:
            return PhraseScore(
                exact=True,
                fuzzy=1.0,
                jaccard=1.0,
                composite=1.0,
                matched_against=cand,
            )
        fuzzy, jaccard = _score_one(predicted_norm, cand_norm)
        composite = 0.6 * fuzzy + 0.4 * jaccard
        if composite > 0.6 * best_fuzzy + 0.4 * best_jaccard:
            best_fuzzy = fuzzy
            best_jaccard = jaccard
            best_match = cand
            best_exact = False

    composite = round(0.6 * best_fuzzy + 0.4 * best_jaccard, 4)
    return PhraseScore(
        exact=best_exact,
        fuzzy=round(best_fuzzy, 4),
        jaccard=round(best_jaccard, 4),
        composite=composite,
        matched_against=best_match,
    )

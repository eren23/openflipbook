"""P4 detector-parse gate (free): the VLM detection reply is coerced tolerantly."""
from __future__ import annotations

from providers.detector import parse_detections


def test_parses_valid_boxes() -> None:
    out = parse_detections(
        {"detections": [{"label": "tower", "x": 0.5, "y": 0.3, "w": 0.2, "h": 0.6, "score": 0.9}]}
    )
    assert out == [
        {"label": "tower", "x_pct": 0.5, "y_pct": 0.3, "w_pct": 0.2, "h_pct": 0.6, "score": 0.9}
    ]


def test_accepts_bare_list_and_entities_key() -> None:
    assert parse_detections([{"label": "a", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}])[0]["label"] == "a"
    assert parse_detections({"entities": [{"label": "b", "x": 0.2, "y": 0.2, "w": 0.1, "h": 0.1}]})[0]["label"] == "b"


def test_drops_incomplete_or_blank_label() -> None:
    out = parse_detections(
        {
            "detections": [
                {"label": "", "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1},
                {"label": "no_h", "x": 0.5, "y": 0.5, "w": 0.1},
                {"label": "good", "x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1},
            ]
        }
    )
    assert [d["label"] for d in out] == ["good"]


def test_clamps_out_of_range() -> None:
    out = parse_detections(
        {"detections": [{"label": "a", "x": 1.5, "y": -0.2, "w": 2.0, "h": 0.5, "score": 9}]}
    )
    assert out[0]["x_pct"] == 1.0
    assert out[0]["y_pct"] == 0.0
    assert out[0]["w_pct"] == 1.0
    assert out[0]["score"] == 1.0


def test_garbage_is_empty() -> None:
    assert parse_detections("nope") == []
    assert parse_detections({}) == []
    assert parse_detections({"detections": "x"}) == []
    assert parse_detections([1, 2, "x"]) == []

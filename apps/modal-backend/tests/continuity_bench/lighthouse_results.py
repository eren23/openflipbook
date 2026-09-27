"""Build a portable, offline gallery of the completed pilot. No provider imports."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import shutil
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
REPORTS = ROOT / "apps/modal-backend/tests/continuity_bench/reports"
OUT = REPORTS / "lighthouse-control-pilot"
REVIEW = ROOT / "docs/research/19-lighthouse-control-review.json"


def build(destination: Path) -> dict:
    manifest = json.loads((OUT / "manifest.json").read_text())
    ledger = json.loads((OUT / "ledger.json").read_text())
    review = json.loads(REVIEW.read_text())
    if manifest["status"] != "complete_not_promoted" or len(manifest["trials"]) != 8:
        raise ValueError("Expected a completed eight-trial pilot")
    for trial in manifest["trials"]:
        pixels = (OUT / f"{trial['id']}.png").read_bytes()
        if hashlib.sha256(pixels).hexdigest() != trial["output_sha256"]:
            raise ValueError(f"Output hash mismatch: {trial['id']}")
    cells = list(ledger["cells"].values())
    summary = {
        "image_calls": sum(c["kind"] == "image" for c in cells),
        "judge_calls": sum(c["kind"] == "llm" for c in cells),
        "reserved_usd": str(sum((Decimal(c["reserved_usd"]) for c in cells), Decimal(0))),
        "reported_judge_cost_usd": str(sum((Decimal(c.get("reported_cost_usd", "0")) for c in cells if c["kind"] == "llm"), Decimal(0))),
        "automatic_passes": sum(t["all_checks_passed"] for t in manifest["trials"]),
        "assistant_passes": sum(t["accepted"] for t in review["trials"].values()),
        "human_review": None,
        "fal_invoice_reconciled": False,
    }
    destination.mkdir(parents=True, exist_ok=True)
    raw = destination / "raw"
    raw.mkdir(exist_ok=True)
    for source in OUT.iterdir():
        if source.is_file() and source.suffix in {".png", ".json"}:
            shutil.copy2(source, raw / source.name)
    guides = destination / "guides"
    guides.mkdir(exist_ok=True)
    for name in ("color.png", "clay.png", "depth.png", "capture.json"):
        shutil.copy2(REPORTS / "lighthouse-guides" / name, guides / name)
    shutil.copy2(REVIEW, destination / "assistant-review.json")
    (destination / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    sections = []
    titles = {"guide_color": "Nano Banana Pro + color guide", "guide_clay": "Nano Banana Pro + clay guide",
              "qwen_eye": "Qwen Multiple Angles: eye level (0 degrees)", "qwen_low": "Qwen Multiple Angles: low angle (-30 degrees)"}
    for variant, title in titles.items():
        figures = []
        for trial in manifest["trials"]:
            if trial["variant"] != variant:
                continue
            key = trial["id"]
            verdict = trial["view_verdict"]
            architecture = "Pass" if trial["architecture"]["accepted"] else "Fail"
            note = html.escape(review["trials"][key]["note"])
            figures.append(f'<figure><a href="raw/{key}.png"><img src="raw/{key}.png" alt="{title}, seed {trial["seed"]}"></a>'
                           f'<figcaption><h3>Seed {trial["seed"]} <span>Rejected</span></h3>'
                           f'<p class="scores">Camera {verdict["conformance"]:g}/10 &middot; Architecture: {architecture} &middot; Style {verdict["medium"]:g}/10</p>'
                           f'<p>{note}</p><a href="raw/{key}-receipt.json">Judge receipt</a></figcaption></figure>')
        sections.append(f'<section><h2>{title}</h2><div class="pair">{"".join(figures)}</div></section>')
    document = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crystal Lighthouse | Control Study</title><style>
*{{box-sizing:border-box}}body{{margin:0;background:#f7f8f8;color:#212626;font:15px/1.5 system-ui,sans-serif;letter-spacing:0}}
main{{max-width:1440px;margin:auto;padding:28px}}h1{{font-size:30px;line-height:1.2;margin:8px 0 14px}}h2{{font-size:20px;margin:0 0 20px}}h3{{font-size:16px;margin:12px 0 6px}}
a{{color:#006e78}}header{{border-bottom:1px solid #bec8c8;padding-bottom:24px}}header p{{max-width:920px}}.meta,.scores{{color:#4d5959;font-size:13px}}
.status{{display:flex;gap:16px;flex-wrap:wrap;margin:22px 0}}.status strong{{border-left:3px solid #a1323d;padding-left:10px}}section{{padding:26px 0;border-bottom:1px solid #bec8c8}}
.pair{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}}figure{{margin:0;min-width:0}}figure img{{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#e8ebec}}
figcaption p{{margin:6px 0}}figcaption span{{color:#9f2b39;font-size:13px;font-weight:500;margin-left:8px}}.references{{display:grid;grid-template-columns:1fr 2fr 2fr;gap:20px}}.references img{{height:260px;aspect-ratio:auto}}footer{{padding:24px 0}}
@media(max-width:760px){{main{{padding:18px}}h1{{font-size:26px}}.pair,.references{{grid-template-columns:1fr}}.references img{{height:220px}}.status{{gap:10px}}}}
</style><main><header><p class="meta">OPENFLIPBOOK / EXPERIMENT 19 / SEPTEMBER 9, 2026</p><h1>Crystal Lighthouse: camera versus architecture</h1>
<p>The guide changes the viewpoint but loses architectural details. Qwen preserves more of the building but keeps the overhead view. None is a faithful ground-level arrival.</p>
<div class="status"><strong>{summary['automatic_passes']}/8 complete passes</strong><strong>${Decimal(summary['reserved_usd']):.2f} accounted/reserved of $4</strong><strong>8 images + 48 judges</strong><strong>No video or promotion</strong></div>
<p class="meta">Assistant visual review, not user sign-off. Camera/style scores and architecture pass/fail are model judgments, not measurements. fal image amounts remain conservative reservations; invoice reconciliation was unavailable.</p>
<a href="REPORT.md">Full report</a> &middot; <a href="raw/manifest.json">Frozen manifest</a> &middot; <a href="raw/ledger.json">Cost ledger</a> &middot; <a href="assistant-review.json">Visual review</a></header>
<section><h2>Source and authored guides</h2><div class="references">
<figure><a href="raw/reference.png"><img src="raw/reference.png" alt="Original lighthouse crop"></a><figcaption>Original crop: identity evidence</figcaption></figure>
<figure><a href="guides/color.png"><img src="guides/color.png" alt="Authored color camera guide"></a><figcaption>Color guide: assumed 1.65 m camera</figcaption></figure>
<figure><a href="guides/clay.png"><img src="guides/clay.png" alt="Authored clay camera guide"></a><figcaption>Clay guide: same geometry and camera</figcaption></figure></div>
<p class="meta">The guide is an authored approximation, not recovered geometry. Its plain annex and simplified base omit visible source features. Depth was exported and tested but was not sent to either model.</p></section>
{''.join(sections)}<footer>Next: repair the source-visible arcade and faceted base in the guide, then review it beside the source before another paid trial. Do not animate a wrong destination.</footer></main></html>'''
    (destination / "index.html").write_text(document)
    report = ROOT / "docs/research/19-lighthouse-control-pilot.md"
    if report.exists():
        shutil.copy2(report, destination / "REPORT.md")
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT / "review")
    print(json.dumps(build(parser.parse_args().out), indent=2))

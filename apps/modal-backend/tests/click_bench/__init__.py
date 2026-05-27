"""Click-resolver micro-benchmark for openflipbook.

Runs ``providers.llm.click_to_subject`` against a frozen fixture set of
``(image_path, tap_xy, expected_subject)`` tuples and scores phrase
similarity. The fixture format is JSON; PIL annotates each image with the
same crosshair the web client draws (``apps/web/lib/image-click.ts``).

Designed to gate VLM swaps: confirm a new resolver model ≥ the current one
on accuracy before shipping. Run via pytest with CLICK_BENCH_RUN=1 + a
real OPENROUTER_API_KEY, or via the CLI in runner.py.
"""

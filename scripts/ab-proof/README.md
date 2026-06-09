# Style-fix A/B proof harness

Reproducible before/after for the medium-lock fix. The trick: run the **same
code in two versions** behind identical input, so the only variable is the fix.

## Setup (two backends, identical corrected env)

The headline bug (interiors coming back photoreal/isometric instead of matching
the source engraving) is **part env, part code**:

- The dramatic drift in the original screenshot was largely the **qwen VLM
  429ing** (it silently fails to extract a style → no lock → nano-banana drifts).
  With Gemini, the resolver extracts the style and even the old code mostly holds.
- The genuinely **code** part is the paths that had *no* style handling at all —
  the **edit path** (dropped the style anchor + sent no style ref) and the
  freehand **stroke-tap**. Those drift regardless of env.

So the clean A/B uses the **corrected env on both sides** (Gemini + nano-banana-pro)
to remove the env confound, and isolates the code:

```bash
# build a throwaway runtime venv (the repo .venv is dev-only)
uv venv /tmp/ofb-rtvenv --python 3.12
uv pip install --python /tmp/ofb-rtvenv/bin/python -r apps/modal-backend/requirements.txt pillow

# pre-fix backend from a worktree on main, fix backend from this branch — both
# with Gemini + nano-banana-pro (overrides the .env qwen/nano-banana gotchas)
git worktree add /tmp/ofb-main main
ln -s "$PWD/apps/modal-backend/.venv" /tmp/ofb-main/apps/modal-backend/.venv   # (or skip; use rtvenv)
ln -s "$PWD/apps/modal-backend/.env"  /tmp/ofb-main/apps/modal-backend/.env

ENV='OPENROUTER_VLM_MODEL=google/gemini-3-flash-preview OPENROUTER_TEXT_MODEL=google/gemini-3-flash-preview FAL_IMAGE_MODEL_BALANCED=fal-ai/nano-banana-pro WORLD_MODE=true GEOMETRIC_WORLD=true WORLD_GEOMETRY_GEN=true IMAGE_CONDITIONING=true'
( cd /tmp/ofb-main/apps/modal-backend && env $ENV PORT=8788 /tmp/ofb-rtvenv/bin/python local_server.py ) &
( cd apps/modal-backend           && env $ENV PORT=8789 /tmp/ofb-rtvenv/bin/python local_server.py ) &
```

## Run

```bash
/tmp/ofb-rtvenv/bin/python scripts/ab-proof/ab_driver.py   # go-inside tap A/B
/tmp/ofb-rtvenv/bin/python scripts/ab-proof/ab_edit.py     # edit A/B (the sharp one)
/tmp/ofb-rtvenv/bin/python scripts/ab-proof/compose.py     # labelled side-by-sides
```

`prefetched_subject` skips the VLM resolver so the subject is deterministic; the
only difference between `:8788` and `:8789` is the style-handling code.

## Result

- **Edit A/B (`ab_edit.py`)** — same `"add a clockwork dragon"` request: pre-fix
  drops the style and nano-banana-pro renders a **glossy photoreal 3D** dragon;
  the fix keeps `"...in a hand-drawn antique engraving style with dense sepia ink
  cross-hatching"` and renders a faithful **engraving**. The clean, env-free proof.
- **Tap A/B (`ab_driver.py`)** — under corrected env both hold the engraving
  (the fix is a little more faithful/consistent), confirming the screenshot's hard
  drift was the env, not the tap code. The fix is the robustness + the edit/stroke
  gaps that had zero handling.

Visual outputs land in `/tmp/ab_*.{jpg,png}` (gitignored; not committed).

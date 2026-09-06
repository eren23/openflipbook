# OUTWARD Source Preservation

Status: experimental, disabled by default. This is not a visual sign-off on #252.

`SCALE_OUTWARD_PRESERVE_SOURCE=1` selects centered outpainting for same-plane
hops, including uploaded roots without `scene_view`. It overrides the hop-refresh
cap on those hops. Astronomical transitions retain the existing rendering path.

The original image is decoded, EXIF-oriented, and passed to the provider as PNG.
The canvas grows 2x in each dimension without resizing the source. After generation,
the full source rectangle is pasted back at the exact requested coordinates. The
final PNG preserves the source's decoded RGBA pixels, not its original JPEG file
bytes. Transparent pixels are preserved too. There is no feathering inside it.

Wrong-size provider output is rejected, not stretched. Remote sources must first
be inlined by the web proxy. Canvases of 25 megapixels or more are refused before
generation. Paid provider results are accounted for even if download or compositing
fails. No dependencies were added.

Both alignment and style judges inspect the final composite before persistence.
Failed or unavailable critics reject the preservation attempt. The normal retry
budget still applies. The older opt-in outpainting path now uses the shared judged
loop too; the default reference-edit path remains unchanged.

## Live Ankh Receipt

One render of `ankh-map-full-spec-2026-08-24.jpg`:

- Source: 1376 x 768; output: 2752 x 1536.
- Decoded source pixels at centre: exactly equal.
- Style: 9.5/10; prompt alignment: 2/10. Rejected by the production stream.
- Visual inspection: a framed map floating in a landscape, not continuous terrain.

Preserving the whole source also preserves its printed border and cartouche.
BRIA interpreted those as a framed object. Pixel identity is therefore proven;
continuous cartographic composition is not. Do not enable this by default or
use this output in a public demo. The next experiment needs an explicit protected
terrain region that excludes page furniture, with its preservation guarantee
clearly distinguished from whole-sheet identity.

## Reproduce

From `apps/modal-backend` (spends one render plus judges, no automatic rerolls):

```sh
OUTWARD_PRESERVE_BENCH_RUN=1 .venv/bin/python -m tests.continuity_bench.outward_preserve_runner \
  --source /path/to/ankh-map-full-spec-2026-08-24.jpg --output /tmp/outward-proof
```

The harness saves the source, final candidate, and JSON receipt even when the
production gate rejects the candidate. `.env` is loaded without exposing keys.
Provider placement constraints: [BRIA Expand API](https://fal.ai/models/fal-ai/bria/expand/api).

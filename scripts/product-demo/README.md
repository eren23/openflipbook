# Product demo editor

Local Remotion timeline for the verified real-UI pilot. This is independent of
the application workspace: no app dependencies or production bundles change.

```sh
npm ci --prefix scripts/product-demo
npm run render --prefix scripts/product-demo
npm run verify --prefix scripts/product-demo
npm run studio --prefix scripts/product-demo
```

Render defaults to the verified take-2 Desktop source MP4 and writes a separate
`openflipbook-product-pilot-v2-2026-09-11.mp4` on the Desktop. Override paths
with `PILOT_SOURCE` and `PILOT_OUTPUT`. The original source must remain the
19.24-second-start trim documented in `docs/PRODUCT_DEMO.md`; the timeline is
frame-indexed against that file at 25 fps, not against the raw capture.

`src/index.tsx` contains the editable timeline, framing, chapter titles and
progress strip. Shot boundaries are deliberate hard cuts between chronological
actions. Nothing is sped up or generated. The final shot skips the reload wait
and labels that omission. Render is silent; check the actual exported streams.

The rendering tool uses its own isolated headless browser, never the user's
signed-in browser. No media upload, public hosting or paid service is involved.
For company-wide adoption, check Remotion's license eligibility:
https://www.remotion.dev/license

The pilot is only a visual-review gate. It does not represent all 118 features
or claim that authored geometry reconstructs the reference image exactly.

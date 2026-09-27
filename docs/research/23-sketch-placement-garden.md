# Sketch Placement And Garden Trial

September 10, 2026. Four single-attempt Flare calls, no rerolls. Three used the
native Sketch UI; object placement used the same renderer through the trial CLI
because file selection was not exposed cleanly by the browser connection. This
is not a claim of a completed live end-to-end placement UI test.

## Results

| Trial | Result | Limitation |
| --- | --- | --- |
| Desk sketch to studio | Clear tabletop, books and pencil cup right, window left | Synthetic source room, not a photographed real room |
| Saved ceramic lamp into studio | Recognizable material/design, plausible scale, base contact and subtle shadow; outside_changed=0 | One visual sample; not measured physical scale |
| Garden drawing to plan | Pond west, bench southeast, pergola northeast, south entrance and L-shaped path retained | No reconstructed geometry |
| Plan to south-entrance view | Landmark sidedness and path topology retained | Camera still reads as elevated rather than the requested human-eye-level arrival; pergola reads as a vertical trellis, not reliably the same structure |

The last output remains an unverified proposal. It is NOT evidence that arrival
geometry is solved. Do not select only the layout success and omit the camera
and structure failures in a public demo.

## Receipts

Unretouched PNGs, drawing screenshot, placement source/guide/mask/subject, and
the placement CLI receipt are in:

`~/Desktop/openflipbook-placement-garden-2026-09-10/`

Native drafts (owner browser required):

- Studio: `fe17e225-e21f-4787-896a-1145043c871a`
- Garden plan: `7bcf05f2-5864-4d90-9052-2760da674fc3`
- Garden proposal: `222d9f0f-8a19-46e1-8062-cf9407920875`

Model: `openai/gpt-image-2.5/flare/edit`. Total estimated allowance $1.20:
$0.90 reserved through the web workflow plus a $0.30 CLI estimate. This is not
an exact provider invoice. The placement response did not return a provider
request ID; its receipt records null rather than inventing one.

## Next Gates

1. Keep this garden as a fixed eval case. Score viewpoint, structure, path
   topology, and landmark sidedness separately.
2. Condition proposals on explicit camera/geometry evidence where available.
   A prompt requesting eye level is not a camera constraint.
3. Add native selection of an already-kept object reference, avoiding a
   download/re-upload round trip. Current uploads remain supported; the obstacle
   in this trial was browser automation, not an observed app-upload failure.
4. Only promote an output to an arrival after geometry/structure gates pass.
   The existing unverified-view label and non-promotion behavior must remain.

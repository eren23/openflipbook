# Full-product demo preflight

## Review gate

The 20.68-second Remotion pilot has been delivered for user review. There is no
recorded user approval yet. Full master and chapter production have not started.
This preflight does not count as recorded feature coverage.

Pilot: `~/Desktop/openflipbook-product-pilot-EDITED-2026-09-11.mp4`.
Scope remains all 118 inventory items across 13 chapters, with experimental or
blocked results explicitly identified rather than hidden or mocked.

## Desktop navigation check

Tested through the connected Brave UI on September 11, 2026, at 1800x992.
Created an isolated fork through the public node's normal Fork this world button:
`session_abd91b98-fd3e-4085-87e8-b3cc916af427`. The original world was not edited.
No generation or animation controls were invoked.

1. Saved fork loaded with ten pages and a four-step trail.
2. Back navigated from Craftsman Workshop by the Well to Eastward.
3. T opened the Session time-scrubber with four saved destinations.
4. DOM inspection confirmed the session minimap was absent while the scrubber
   was open. `elementFromPoint` at the close button's center returned the button
   or its descendant: it was not covered by another overlay.
5. A normal role-based click on Close time-scrubber succeeded, without force or
   a keyboard workaround. The scrubber count became zero and minimap expand
   button count returned to one.

The current `app/play/page.tsx` already excludes SessionMinimap when
`scrubberOpen` is true. No product code was changed for this preflight. The old
overlap report is not reproduced at this desktop viewport. Narrow/mobile
viewports remain unverified; do not generalize this result to them.

## Material color limitation

The source audit confirms `applyStreetMaterials` assigns white or a fixed stone
tint to textured mesh materials, overriding the generic object color. The color
field can persist a value without visibly changing these street surfaces.
`applyRoofMaterials` uses a separate tint uniform, and the teal roof change has
real visual and persistence proof in the delivered pilot.

For full coverage, demonstrate generic color on an actually supported surface,
or fix and visually verify its street-texture behavior before claiming that it
works there. Do not label a stored-only color edit as a visible material change.

## Focused tests

Command, from `apps/web`:

```sh
pnpm exec vitest run components/session-minimap.test.tsx components/PlayPage/WorldMiniMap.test.tsx components/sketch/street-materials.test.ts
```

Result: 3 files passed, 12 tests passed. These cover component behavior and
roof-tint/UV invariants, not full demo coverage or live image-model quality.
No full-suite claim is made.

## Next gate

Obtain the user's visual verdict on the existing pilot. Use it to accept or
revise the editing style before producing the master and chapter exports.

## AI versus procedural creation

The user's follow-up questions exposed ambiguity about what creates the building.
The current world editor adds a procedural component selected from its dropdown.
The pilot selects House during setup, before its first retained frame; it does
not show a prompt-to-mesh or AI-to-3D workflow. The v2 captions explicitly name
the House preset and label the segment Procedural 3D editing. Source actions and
timings are unchanged, and the original export remains available.

The full demo must separately show AI image generation/editing in Sketch and
authored 3D geometry editing. Keeping an AI image does not automatically create
a matching editable mesh. Describe a place can propose a logical layout behind
its feature flag, but that is not evidence of a generated textured mesh pipeline.
No new AI-to-3D feature is implemented or claimed by this editorial correction.

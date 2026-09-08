# Spatial Transitions

The transition contract preserves evidence about a saved parent/child edge.
It is not a reconstructed camera path or a guarantee that the generated child
depicts the correct place.

`transition_context` is optional on node reads. Version 1 binds the source node
and immutable image key to a normalized target point, optional source-image
bounding box and geo identity, target provenance, and source/destination camera
snapshots. The server derives the source image key from the authorized parent;
clients cannot choose another image. A direct tap remains the motion target
even when the available entity box has a different center.

Context is frozen when the child is saved. Later extraction and camera edits
do not rewrite that historical evidence. Fresh page state and reloads carry
the same context. Forks remap node references without copying images; world
exports include the context. Older nodes remain readable without backfills
or additional provider calls.

Source-pixel playback and its opt-in navigation integration are separate from
this data contract. The existing generated-video route and defaults are not
changed by recording context.

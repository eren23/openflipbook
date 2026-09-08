# Frozen Arrival Inputs

These three original JPEGs are unchanged baseline outputs from the completed
place-identity pilot, not newly generated fixtures. The corresponding parent maps
are committed under `tests/click_bench/fixtures/images/real/`.

The inputs deliberately retain their failures: the lighthouse requests arrived
at docks/harbors, and the citadel request arrived at an oasis scene. They test
whether a transition follows supplied frames, not whether it repairs a wrong
destination. Do not relabel them as accepted canonical views.

Exact SHA-256 hashes, prompts, settings, and video request IDs are in
`docs/research/12-transition-video-pilot.json` at the repository root. Keeping
these original bytes makes the experiment reproducible without paying to
regenerate its inputs. The runner prefers an existing local pilot output, then
falls back to these archived originals.

# `apps/web/components/PlayPage/`

Pure-visual primitives for the `/play` surface. Each component takes
plain props, has no state of its own beyond UI-local refs, and no
closure capture of orchestrator state. If you need React state or
effects, that probably belongs in `apps/web/hooks/`.

See [`docs/ARCHITECTURE.md`](../../../../docs/ARCHITECTURE.md) for the
full layer cake.

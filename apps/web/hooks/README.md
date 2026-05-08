# `apps/web/hooks/`

State + effect hooks pulled out of `app/play/page.tsx`. Each owns one
bounded concern; hooks must not import each other (the orchestrator
composes them). Add a unit test next to a new hook when it has
branching logic.

See [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) for the
full layer cake and the rule of thumb for "where does this go".

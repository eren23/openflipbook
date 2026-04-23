# Security Policy

## Threat model

Endless Canvas is a BYO-keys, self-hosted project. There is no central server, no pooled credentials, and no hosted playground. Each deployment is operated by the user who cloned the repo, using their own fal / OpenRouter / Cloudflare R2 / MongoDB / Modal credentials.

Consequently, the security surface we maintain covers:

- Not leaking the operator's API keys through logs, server-side errors, or client-side bundles.
- Not exposing R2 buckets or Mongo instances beyond what the operator configured.
- Not introducing code that silently phones home, relays user queries to third parties, or bypasses the operator's key-based rate limits.

Out of scope (these are the operator's responsibility):

- Rotating their own keys.
- Firewalling their own Modal / Mongo / R2 endpoints.
- Reviewing third-party models' terms of service (fal, OpenRouter, Cloudflare, etc.).

## Reporting a vulnerability

Please email **erenakbulutwork@gmail.com** with the details. Use "Endless Canvas security:" as the subject prefix.

- Do **not** open a public GitHub issue for anything that could expose operator keys or user data.
- Expect a first response within ~5 working days. Fixes are best-effort; this is a side project.
- If you need PGP, say so in your first mail and a key will be provided.

## Supported versions

The `main` branch is the only supported version. Tagged releases are best-effort and do not receive backports.

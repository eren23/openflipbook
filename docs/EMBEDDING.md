# Embedding worlds elsewhere

A published world is embeddable: `/embed/<sessionId>` is a read-only
interactive viewer that works in any iframe, `/api/oembed` is a JSON oEmbed
provider, and `public/embed.js` is a one-line wrapper for pages without
oEmbed. This page is the deployer's handbook for lighting up each channel.
Everything here assumes a PUBLIC deployment domain — replace
`https://YOUR-DOMAIN` throughout. Worlds must be published (right-click →
"Publish session to gallery") before any of this renders them.

## What the app already ships

- `GET /embed/<sessionId>` — the viewer (publish-gated, `frame-ancestors *`
  on this path only).
- `GET /api/oembed?url=<share-url>` — oEmbed JSON (`rich` type); 404 for
  unpublished sessions.
- `/n/<nodeId>` share pages carry the oEmbed discovery `<link>` plus Open
  Graph and Twitter Card tags.
- `https://YOUR-DOMAIN/embed.js` + `<div data-openflipbook="...">` — the
  script wrapper.

## Discourse forums (the cheapest on-ramp)

Discourse admins allow iframe sources with one site setting — no plugin.
Hand a forum admin this recipe:

1. Admin → Settings → search `allowed_iframes`.
2. Add `https://YOUR-DOMAIN/embed/` to the list.
3. Any user can then paste the iframe into a post:

```html
<iframe src="https://YOUR-DOMAIN/embed/SESSION_ID"
        width="720" height="450" frameborder="0"></iframe>
```

Reference: the `allowed_iframes` setting on Discourse Meta
(https://meta.discourse.org/t/whitelist-allowed-iframe/97738).

## The oEmbed provider registry (oembed.com)

The registry at https://oembed.com feeds Discourse onebox, WordPress, and the
`oembed-providers` npm ecosystem. To register a public deployment, fork
`iamcal/oembed` and add `providers/openflipbook.yml`:

```yaml
- provider_name: openflipbook
  provider_url: https://YOUR-DOMAIN/
  endpoints:
    - schemes:
        - https://YOUR-DOMAIN/n/*
        - https://YOUR-DOMAIN/embed/*
      url: https://YOUR-DOMAIN/api/oembed
      discovery: true
      formats:
        - json
```

The spec asks providers to also serve discovery tags — the `/n/` pages
already do.

## Iframely (the Notion path)

Notion resolves pasted links through Iframely's QA'd whitelist. The QA
checks: a working oEmbed endpoint, Open Graph + Twitter Card fallbacks,
valid SSL, and a responsive iframe. The share pages carry all four; submit
the public domain at https://iframely.com/docs/whitelist-format once it
exists. Listing is free.

## Future modules (researched, not built)

- **FoundryVTT**: GMs already iframe external map sites into journals
  (see the Inline Webviewer module) and their documented pain is sites
  that BLOCK framing — which our embed path deliberately allows. A minimal
  `module.json` + journal sheet would list on foundryvtt.com/packages.
- **Obsidian**: a one-file community plugin rendering openflipbook links as
  the live viewer, listed via a PR to `obsidianmd/obsidian-releases`.

## The one prerequisite

Every channel above needs a public HTTPS deployment. The registry PR and
Iframely submission name a real domain — do them once, per deployment,
after that domain exists.

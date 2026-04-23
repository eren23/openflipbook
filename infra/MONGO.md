# MongoDB setup

Endless Canvas stores the node graph in a single MongoDB collection named
`nodes`. No schema file is needed — Mongo creates the collection on first
insert, and the web app creates indexes automatically on first connection
(see `apps/web/lib/db.ts`).

## Indexes (created automatically)

- `{ session_id: 1, created_at: -1 }` — list pages in a session.
- `{ parent_id: 1 }` — traverse the explore graph downward.

## Document shape

```json
{
  "_id": "<uuid>",
  "parent_id": "<uuid>|null",
  "session_id": "session_<uuid>",
  "query": "how does a steam engine work",
  "page_title": "How a Steam Engine Works",
  "image_key": "<session-prefix>/<uuid>.jpg",
  "image_model": "fal-ai/nano-banana",
  "prompt_author_model": "qwen/qwen-2.5-72b-instruct:online",
  "aspect_ratio": "16:9",
  "final_prompt": "...",
  "created_at": "2026-04-23T12:00:00.000Z"
}
```

## Where to host

- **Railway Mongo template** — cheapest if you already have Railway capacity.
- **MongoDB Atlas M0** — free tier, hosted. Works fine.
- **Docker locally**: `docker run -p 27017:27017 mongo:7`

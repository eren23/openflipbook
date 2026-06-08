import type { Collection, Document } from "mongodb";

// Shared optimistic-concurrency read-modify-write loop. Both world_state
// (world.ts) and world_map (world-map.ts) persist a single per-session doc that
// many fire-and-forget writers can race on. Each one read the doc, mutated it in
// memory, then `replaceOne`-d filtered on the seen `updated_at` so a parallel
// writer that landed first would force a retry instead of being silently
// clobbered; a fresh row uses `insertOne` and recovers from the duplicate-key
// error by looping (which then sees the row and takes the replace path). That
// skeleton was copy-pasted four times — this is the single copy.
//
// Behaviour is byte-for-byte the previous inline loops: same retry cap, same
// `{ _id, updated_at }` filter, same dup-key recovery, same exhaustion throw.
// The doc's `updated_at` bump and all field semantics stay in `build` — this
// helper only persists whatever `build` returns.

// Minimal shape the loop needs: a string _id and an updated_at it can pin the
// optimistic filter on. Both WorldStateDoc and WorldMapDoc satisfy it.
export interface OptimisticDoc extends Document {
  _id: string;
  updated_at: Date;
}

export interface OptimisticReplaceOptions {
  /** Retry budget (matches the per-module OPTIMISTIC_RETRY_LIMIT). */
  retryLimit: number;
  /** Mongo duplicate-key predicate (each module passes its own; both check
   *  code === 11000). Lets the first-write path distinguish a lost insert race
   *  from an unrelated error. */
  isDuplicateKeyError: (err: unknown) => boolean;
  /** Label for the "retry exhausted" error so the message names the caller. */
  label: string;
}

/**
 * Read the `id` doc, build its replacement, and persist it under optimistic
 * concurrency. `build` receives the freshly-read doc (or `null` when the row
 * doesn't exist yet) and must return the FULL replacement doc — including the
 * new `updated_at`. On a conflicting concurrent write (or a lost first-write
 * insert race) the loop re-reads and re-builds, up to `retryLimit` attempts.
 *
 * Returns the persisted doc (the exact object `build` produced on the winning
 * attempt) so the caller can map it to a wire snapshot.
 */
export async function optimisticReplace<TDoc extends OptimisticDoc>(
  col: Collection<TDoc>,
  id: string,
  build: (existing: TDoc | null) => TDoc,
  opts: OptimisticReplaceOptions
): Promise<TDoc> {
  let attempt = 0;
  while (true) {
    // findOne returns WithId<TDoc>; since OptimisticDoc already pins `_id` it's
    // structurally TDoc, but the generic can't prove that — coerce at the seam.
    const existing = (await col.findOne({ _id: id } as never)) as TDoc | null;
    const next = build(existing);

    let ok = false;
    if (existing) {
      const write = await col.replaceOne(
        { _id: id, updated_at: existing.updated_at } as never,
        next
      );
      ok = write.matchedCount === 1;
    } else {
      // First-write path: insertOne. If another writer beat us, the
      // duplicate-key error sends us around the loop, which now sees the row
      // and uses the optimistic-replace path — closing the gap where two
      // parallel first-writes could both upsert and clobber.
      try {
        await col.insertOne(next as never);
        ok = true;
      } catch (err) {
        if (!opts.isDuplicateKeyError(err)) throw err;
        ok = false;
      }
    }

    if (ok) return next;
    attempt += 1;
    if (attempt >= opts.retryLimit) {
      throw new Error(
        `${opts.label}: optimistic concurrency retry exhausted for ${id}`
      );
    }
  }
}

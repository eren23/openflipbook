import type { WorldEntityGeo } from "@openflipbook/config";

/**
 * Match the VLM's read of a tap ("The Patrician's Palace and its gardens")
 * against the mapped entities, so a click on a map's baked-in LETTERING
 * enters the named place instead of falling through to the fresh path
 * (which ignores image refs and invents an unrelated scene).
 *
 * Pure. Mirrored (loosely) by generate.py's _match_world_entity for the
 * auto-autonomy path where the VLM resolve happens in-band.
 */

// Words that carry no identity — dropped before token comparison so
// "the palace of the patrician" still meets "Patrician's Palace".
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "and", "its", "their", "in", "on", "at",
]);

/** lowercase → strip diacritics → strip punctuation → collapse spaces.
 *  Apostrophes are REMOVED (not space-split) so "Patrician's" folds to
 *  "patricians" rather than shedding a stray "s" token. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

/** Character-bigram Dice similarity on the normalized strings (0..1) —
 *  the fuzzy net for near-misses ("patricians palace" vs "patrician palace"). */
function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let overlap = 0;
  let total = 0;
  for (const [g, n] of ga) {
    overlap += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return (2 * overlap) / total;
}

const FUZZY_THRESHOLD = 0.8;

/** Match strength: exact (3) > token containment (2) > fuzzy bigram (1) > none (0). */
function matchStrength(subject: string, label: string): number {
  const ns = normalize(subject);
  const nl = normalize(label);
  if (!ns || !nl) return 0;
  if (ns === nl) return 3;
  const ts = tokens(subject);
  const tl = tokens(label);
  if (ts.length === 0 || tl.length === 0) return 0;
  // Token-set containment, either direction: a subject "patrician's palace
  // and its gardens" contains the label "Patrician's Palace"; a clipped
  // subject "the river" is contained by the label "The River Ankh".
  const setS = new Set(ts);
  const setL = new Set(tl);
  if (tl.every((t) => setS.has(t)) || ts.every((t) => setL.has(t))) return 2;
  if (bigramSimilarity(ns, nl) >= FUZZY_THRESHOLD) return 1;
  return 0;
}

export function matchEntityLabel(
  subject: string,
  entities: WorldEntityGeo[],
): WorldEntityGeo | null {
  if (!subject.trim()) return null;
  let best: WorldEntityGeo | null = null;
  let bestScore = 0;
  for (const e of entities) {
    if (!e.label.trim()) continue;
    const strength = matchStrength(subject, e.label);
    if (strength === 0) continue;
    // Places outrank non-places at equal strength (a tap on lettering is a
    // tap on a PLACE name); ties keep the first (closest-seeded) entity.
    const score = strength * 2 + (e.kind === "place" ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

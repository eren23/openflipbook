import type { Entity, WorldEntityGeo } from "@openflipbook/config";

interface OutwardContextInput {
  nodeId: string | null;
  title?: string | null;
  query?: string | null;
  entities: Pick<
    Entity,
    | "name"
    | "kind"
    | "appearance"
    | "facts"
    | "appears_on_node_ids"
    | "first_seen_node_id"
    | "last_seen_node_id"
  >[];
  geos: Pick<WorldEntityGeo, "label" | "parent_id">[];
}

const GENERIC_ROOT_TITLES = new Set([
  "",
  "uploaded image",
  "uploaded map",
  "image upload",
  "untitled image",
  "untitled map",
]);

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isGenericRootTitle(value: string | null | undefined): boolean {
  return GENERIC_ROOT_TITLES.has(cleanText(value).toLowerCase());
}

function pushUnique(out: string[], value: string | null | undefined): void {
  const text = cleanText(value);
  if (!text || isGenericRootTitle(text)) return;
  const key = text.toLowerCase();
  if (out.some((v) => v.toLowerCase() === key)) return;
  out.push(text);
}

function entityOnNode(
  entity: OutwardContextInput["entities"][number],
  nodeId: string | null,
): boolean {
  if (!nodeId) return true;
  return (
    entity.first_seen_node_id === nodeId ||
    entity.last_seen_node_id === nodeId ||
    entity.appears_on_node_ids.includes(nodeId)
  );
}

export function buildOutwardContext({
  nodeId,
  title,
  query,
  entities,
  geos,
}: OutwardContextInput): string | null {
  const names: string[] = [];
  if (!isGenericRootTitle(title)) pushUnique(names, title);
  if (!isGenericRootTitle(query)) pushUnique(names, query);

  for (const geo of geos) {
    if (geo.parent_id) continue;
    pushUnique(names, geo.label);
    if (names.length >= 14) break;
  }

  const onPage = entities.filter((e) => entityOnNode(e, nodeId));
  const places = onPage.filter((e) => e.kind === "place");
  const others = onPage.filter((e) => e.kind !== "place");
  for (const entity of [...places, ...others]) {
    pushUnique(names, entity.name);
    if (names.length >= 14) break;
  }

  const details: string[] = [];
  for (const entity of [...places, ...others]) {
    const fact = entity.facts.find((f) => cleanText(f).length > 0);
    const detail = cleanText(fact || entity.appearance);
    if (!detail) continue;
    details.push(`${cleanText(entity.name)}: ${detail.slice(0, 120)}`);
    if (details.length >= 5) break;
  }

  if (!names.length && !details.length) return null;
  const parts = [
    names.length ? `Known names on the source map: ${names.join(", ")}.` : "",
    details.length ? `Source map details: ${details.join("; ")}.` : "",
    "OUTWARD must contain this exact established map at the centre; do not invent an unrelated geography or title.",
  ].filter(Boolean);
  return parts.join(" ");
}

// Strip view/angle/distance phrasing from an entity's appearance so the part
// that should stay CONSTANT across zoom levels — its identity (materials,
// architecture, distinctive features) — survives, while the part that legitimately
// changes when you enter it (the camera angle) is dropped. Without this, feeding
// "a circular stone spire SEEN FROM DIRECTLY ABOVE" as the entered-scene context
// forces a top-down render of a tower you're standing next to.

const VIEW_PHRASES: RegExp[] = [
  /\b(?:seen|viewed|shown|rendered|depicted|captured)\s+from\s+(?:directly\s+)?above\b/gi,
  /\bfrom\s+(?:directly\s+)?above\b/gi,
  /\b(?:seen|viewed|shown)\s+from\s+the\s+side\b/gi,
  /\bfrom\s+the\s+side\b/gi,
  /\bin\s+plan\s+view\b/gi,
  /\btop[-\s]?down\b/gi,
  /\bbird'?s[-\s]?eye(?:\s+view)?\b/gi,
  /\baerial\b/gi,
  /\boverhead\b/gi,
  /\b(?:at\s+)?street[-\s]level\b/gi,
  /\b(?:at\s+)?ground[-\s]level\b/gi,
  /\bclose[-\s]?up\b/gi,
];

export function viewNeutralAppearance(
  visual: string | null | undefined,
): string {
  if (!visual) return "";
  let s = visual;
  for (const re of VIEW_PHRASES) s = s.replace(re, "");
  // Tidy the grammar the removals leave behind.
  s = s
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1") // " ," -> ","
    .replace(/,\s*,/g, ",") // ", ," -> ","
    .replace(/,\s*\./g, ".") // ", ." -> "."
    .replace(/\(\s*\)/g, "") // empty parens
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[,;.\s]+/, "") // leading punctuation
    .replace(/[,;\s]+$/, "") // trailing comma/space
    .trim();
  return s;
}

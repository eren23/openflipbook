export const SPATIAL_STUDY_CASES = [
  { id: "fishing_lighthouse", title: "North Point Lighthouse", source: "fishing_village.jpg", x: .557, y: .192, destination: "Waking Docks", h3: "fishing_lighthouse-h3-c63f6dc519.mp4", ltx: "fishing_lighthouse-ltx-cb4313341e.mp4" },
  { id: "oasis_citadel", title: "Sandstone Citadel", source: "oasis_town.jpg", x: .631, y: .204, destination: "Oasis of Zaffar", h3: "oasis_citadel-h3-c455972127.mp4", ltx: "oasis_citadel-ltx-8fe4ef43ad.mp4" },
  { id: "harbor_lighthouse", title: "Crystal Lighthouse", source: "harbor_aethelgard.jpg", x: .138, y: .312, destination: "Grand Harbor", h3: "harbor_lighthouse-h3-b0f5104ef3.mp4", ltx: "harbor_lighthouse-ltx-8c2a03c85c.mp4" },
] as const;

/** Explicit local fixture allowlist. Never accepts a filesystem path from a URL. */
export function spatialAssetPath(name: string): string | null {
  for (const c of SPATIAL_STUDY_CASES) {
    if (name === c.source) return `tests/click_bench/fixtures/images/real/${c.source}`;
    if (name === `${c.id}-destination.jpg`) return `tests/video_transition_bench/fixtures/${name}`;
    if (name === c.h3 || name === c.ltx) return `tests/video_transition_bench/reports/${name}`;
  }
  return null;
}

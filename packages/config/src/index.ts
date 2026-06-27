export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4";

export type GenerateMode = "query" | "tap" | "edit" | "expand" | "ascend";

// Scale of a node's subject relative to its parent's focal subject, for the
// scale-space world map + zoom level-of-detail. Composes into an integer
// scale-level: component = -1, peer = 0, container = +1.
export type ScaleKind = "component" | "peer" | "container";

// ââ Scale ladder (B2, SCALE_LADDER_NAV) ââââââââââââââââââââââââââââââââââââââ
// An explicit, ordered, metric-anchored zoom axis: a node's COARSE absolute
// "where on the zoom axis am I". Distinct from ScaleKind (relative:
// component/peer/container) and from WorldEntityGeo.scale (fine metric: the size
// of one unit of this frame). B2 navigation (OUTWARD/AROUND/DEEPER) moves along
// this ladder; it EXTENDS the existing relative scale, never replaces it.
export const SCALE_LADDER = [
  "universe", "galaxy", "star_system", "planet",
  "world", "region", "city", "district", "place", "room", "object",
] as const;
export type ScaleTier = (typeof SCALE_LADDER)[number];

// Order-of-magnitude metric anchor (metres) per rung â the bridge that makes the
// ladder metric-conserving. ~27 orders of magnitude end to end, so callers
// store/compare in LOG space. `world` and `planet` share an anchor by design (a
// "world" is a planet-surface framing); tierStep still separates them by index.
export const SCALE_TIER_METERS: Record<ScaleTier, number> = {
  universe: 8.8e26, galaxy: 9.5e20, star_system: 1.5e13, planet: 1.3e7,
  world: 1.3e7, region: 3e5, city: 1.5e4, district: 1.5e3,
  place: 1.2e2, room: 1.0e1, object: 1.0e0,
};

export function tierIndex(t: ScaleTier): number {
  return SCALE_LADDER.indexOf(t);
}
// Signed index delta (universe=0 .. object=last). A finer target (toward
// `object`, DEEPER) is +; a coarser target (toward `universe`, OUTWARD) is -.
export function tierStep(from: ScaleTier, to: ScaleTier): number {
  return tierIndex(to) - tierIndex(from);
}
// Per-transition metric multiplier = ratio of rung metres. OUTWARD (coarser)
// is > 1 (region/city ~= 20x); DEEPER (finer) is < 1.
export function tierMetricMultiplier(from: ScaleTier, to: ScaleTier): number {
  return SCALE_TIER_METERS[to] / SCALE_TIER_METERS[from];
}
// INV-2: the metric span must move monotonically with the rung step â going
// DEEPER (step > 0) shrinks it (multiplier <= 1), OUTWARD (step < 0) grows it
// (multiplier >= 1); ==1 is allowed only between the deliberately-equal
// world/planet rungs. A transition that violates this is a mis-classified rung
// and must be rejected (don't persist; fall back).
export function tierTransitionValid(from: ScaleTier, to: ScaleTier): boolean {
  const step = tierStep(from, to);
  if (step === 0) return true;
  const m = tierMetricMultiplier(from, to);
  return step > 0 ? m <= 1 : m >= 1;
}
// One rung FINER (toward `object`, DEEPER); clamps at `object`. The inverse of the
// Python `model_router.coarser_tier` used by OUTWARD â together they make a tap a
// `tierStep` of +1 and an OUTWARD â1 on the SAME ladder.
export function finerTier(t: ScaleTier): ScaleTier {
  const i = tierIndex(t);
  return SCALE_LADDER[Math.min(i + 1, SCALE_LADDER.length - 1)] ?? t;
}

// How a node relates to its parent: "descend" = went IN (a tap child, the
// default), "expand" = bloomed OUT (a neighbour from mode:"expand"), "ascend" =
// zoomed OUT to a synthesized container (the OUTWARD reparent, SCALE_OUTWARD),
// "edit" = a REVISION of the parent (mode:"edit") â the same page changed, not
// a place inside it, so the graph chrome must not read it as a tap-in.
export type NodeRelation = "descend" | "expand" | "ascend" | "edit";

export type ImageTier = "fast" | "balanced" | "pro";

export type VideoTier = "fast" | "balanced" | "pro";

// World Mode (opt-in). `autonomy` "auto" generates straight away; "semi" first
// surfaces the resolver's clarifying questions. `RenderMode` is how a tapped
// subject is drawn â an immersive place you've stepped into, a closer
// cartographic map of a sub-area, or today's labelled explainer diagram.
export type Autonomy = "auto" | "semi";
// place_closeup = the descent ladder's closeup rung on a NON-map frame (a
// Kontext zoom of a thing inside a perspective scene). Backend accepts it
// since the same release; old backends coerce unknown modes to the fresh path.
export type RenderMode =
  | "place_scene"
  | "place_submap"
  | "place_closeup"
  | "explainer";
// The click-resolver's read of what was tapped (drives RenderMode in world mode).
export type EnterAs = "scene" | "submap" | "explainer";

export interface GenerateRequestBody {
  query: string;
  aspect_ratio: AspectRatio;
  web_search: boolean;
  session_id: string;
  current_node_id: string;
  mode?: GenerateMode;
  image?: string;
  parent_query?: string;
  parent_title?: string;
  click?: { x_pct: number; y_pct: number };
  // Free-form note from the user, captured via cmd/ctrl-click on the image
  // ("show this from a cross-section", "explain like I'm 5"). Folded into the
  // planner query so the next page reflects the user's specific angle.
  click_hint?: string;
  image_tier?: ImageTier;
  image_model?: string;
  // Per-request loop control (the speed preset). Absent -> the backend's env
  // defaults, byte-identical to today. `verify: false` skips the judged
  // render/edit loops for this request (a fast, un-judged single shot);
  // `max_attempts` clamps server-side to the loops' hard cap.
  max_attempts?: number;
  verify?: boolean;
  edit_instruction?: string;
  // Mask-scoped edit (EDIT_REGION; the backend gates it behind the env flag so
  // it's a no-op until enabled). `edit_mask` is an opaque PNG data URL at the
  // page's natural dims, WHITE = edit / black = keep (flux fill's native
  // convention); `edit_region` is the drag selection that produced it,
  // normalized to natural-image space â the mask drives the model, the box
  // scopes the judge's inside crop. Absent -> the legacy whole-image edit.
  edit_mask?: string;
  edit_region?: { x: number; y: number; w: number; h: number };
  // BCP-47 short tag (e.g. "en", "tr", "ja"). When set, the planner +
  // click-resolver are instructed to emit titles, labels, and the click
  // subject in this language. Image labels render in-pixel via the model.
  output_locale?: string;
  // Hover-prefetched click resolution. When present, the SSE stream skips
  // the VLM call entirely on tap mode, cutting ~600-1200ms off the hop.
  prefetched_subject?: string;
  prefetched_style?: string;
  // Optional one-sentence disambiguation of the subject (e.g. "per-object
  // memory store the SAM 2 tracker uses to keep object identity across
  // frames"). Backend feeds this to plan_page as authoritative meaning so
  // ambiguous phrases stay in the parent's domain.
  prefetched_subject_context?: string;
  // World Mode: the resolver's spatial-anchor note ("river to the south, the
  // Citadel NE") carried back so the planner keeps the entered place's
  // neighbours where the parent map had them. Mirrors GenerateBody.
  prefetched_surroundings?: string;
  // Sightline-culled surroundings (world geometry): prefetched_surroundings is
  // VIEW-relative (frame positions from the observer pose, not map bearings)
  // and surroundings_behind names the mapped landmarks OUTSIDE the view
  // frustum - banned from the backdrop. Absent -> legacy bearing wording.
  surroundings_pov?: boolean;
  surroundings_behind?: string;
  // Multi-turn refer (SAMA / MM-Conv): when the user rejects a resolved
  // subject and taps again nearby, the client forwards the rejected
  // phrase so the VLM picks something different next time.
  prior_rejected_subject?: string;
  // Session-level style lock. When set, the planner uses this as the
  // visual style for ALL pages in the session, overriding the per-hop
  // style derived from the parent. Pin a page in the UI to populate.
  session_style_anchor?: string;
  // World-memory continuity injection. The web proxy at /api/generate-page
  // resolves a slim slice of the session's world_state before forwarding
  // upstream. Each entry's `appearance` gets injected into the planner's prompt
  // so recurring characters / places preserve their look across pages without
  // the user having to re-describe them.
  world_context?: WorldContextEntity[];
  // Image conditioning â an ordered stack of reference images (data URLs) the
  // generator blends so the page belongs to the same world: region crop (the
  // spot you came from) â whole parent â global style anchor. `condition_roles`
  // labels each url in order so the backend can phrase the conditioning prompt.
  // Built client-side (lib/image-condition.ts). Omit â today's text-only gen.
  condition_image_urls?: string[];
  condition_roles?: string[];
  // World Mode (opt-in; the backend also gates it behind the WORLD_MODE env so
  // it's a no-op in prod until enabled). When on, a tap ENTERS the tapped place
  // â a scene you stand in or a closer sub-map â instead of explaining a topic,
  // and the place persists + reopens. `render_mode` explicitly overrides the
  // per-place framing the resolver would otherwise pick from `enter_as`.
  world_mode?: boolean;
  autonomy?: Autonomy;
  render_mode?: RenderMode;
  // DOM-labels mode (NEXT_PUBLIC_DOM_LABELS): map/explainer renders carry NO
  // baked text — names ride a client overlay built from entity data. Optional
  // + default-absent: old clients omit it, prompts stay byte-identical.
  suppress_map_labels?: boolean;
  // Tap descent ladder: the SOURCE frame of this enter was a closeup of the
  // place — the establishing shot already happened, so the enter goes to
  // ground level (grounds/courtyard) instead of another aerial.
  from_closeup?: boolean;
  // B2 logical AROUND (mode:"expand", SCALE_AROUND_LOGICAL). The same-scale
  // neighbours the client already knows from geometry (excluded) + the focus's
  // rung, so the bloom proposes NEW peers at that scale. Ignored unless the flag
  // is on; absent â today's unconstrained bloom.
  known_neighbors?: string[];
  around_tier?: ScaleTier;
  // Geometric world (GEOMETRIC_WORLD). The scene's observer pose + level, and the
  // geometry engine's expected per-entity layout for this frame, so the planner
  // can constrain placement and the grounding loop has a target to check against.
  scene_view?: SceneView;
  expected_layout?: ProjectedEntity[];
  trace_id?: string;
}

export interface WorldContextEntity {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  appearance: string;
  // Optional R2 URL of the first-seen crop. When the image provider
  // supports img2img, the renderer can use this as conditioning for
  // stronger continuity than text descriptor alone.
  reference_image_url?: string | null;
  // Free-form key/value state. Helps the planner thread the entity's
  // current condition (door open / lit / wounded) into the prompt.
  state?: EntityState;
  // Optional geometric size (world units) carried from the entity's
  // WorldEntityGeo when the web proxy resolves the slice. Lets the planner
  // hint a consistent relative scale for recurring entities across pages so a
  // building rendered large once doesn't come back tiny next time. Omitted â
  // today's behaviour (appearance text only).
  footprint?: { w: number; d: number };
  height?: number;
  // Compass phrase from the entity's top-level map geo ("the north-west of
  // the map", "spanning the map east–west across its middle") — the spatial
  // half of continuity. The clause builder renders it as a fixed-position
  // instruction so landmarks stop relocating between pages. Omitted →
  // appearance-only continuity, exactly today's behaviour.
  location_hint?: string;
}

export interface ResolveClickRequestBody {
  image_data_url: string;
  x_pct: number;
  y_pct: number;
  parent_title?: string;
  parent_query?: string;
  output_locale?: string;
  prior_rejected_subject?: string;
  // World Mode: ask the resolver to also classify what was tapped (`enter_as`)
  // and, in "semi" autonomy, propose short clarifying questions before entering.
  world_mode?: boolean;
  autonomy?: Autonomy;
  trace_id?: string;
}

// VLM's best-estimate centroid of the resolved subject (0..1 in image
// frame). Powers the "we think you tapped this â yes/try again" overlay.
export interface ResolveClickPoint {
  x: number;
  y: number;
}

// Optional bounding box around the resolved subject. Omitted when the
// VLM cannot give a tight box (cf. GroundingME findings on rejection).
export interface ResolveClickBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolveClickResponse {
  subject: string;
  style: string;
  // One-sentence definition of `subject` *as it appears in the parent
  // illustration*. Threaded into the planner as the authoritative meaning
  // so an ambiguous phrase like "Memory Bank" doesn't drift to the
  // popular web meaning when the parent is a video-segmentation diagram.
  subject_context?: string;
  // VLM's self-reported groundability + confidence + best-estimate region.
  // Default behaviour when omitted: treat as groundable=true, confidence=1.
  groundable?: boolean;
  confidence?: number;
  point?: ResolveClickPoint | null;
  bbox?: ResolveClickBBox | null;
  // World Mode: the resolver's read of what was tapped (a place to step into, a
  // sub-area to map closer, or a concept to explain) + up to two short
  // clarifying questions (semi autonomy only). Absent in classic mode.
  enter_as?: EnterAs;
  clarifiers?: string[];
  // World Mode spatial anchor: what sits AROUND the tapped spot and in which
  // direction ("river to the south, timbered houses west, market square NE"),
  // so the entered place keeps its neighbours where the parent map had them.
  surroundings?: string;
}

export interface GenerateProgressEvent {
  type: "progress";
  frame_index: number;
  jpeg_b64: string;
  trace_id?: string;
}

export interface Citation {
  url: string;
  title?: string | null;
}

// Geometric grounding result (VLM_GROUNDING): how well the rendered frame
// matched the expected layout, plus whether a corrective edit ran. Present on
// `final` only when grounding was enabled for the request.
export interface GroundingSummary {
  score: number; // 0..1 layout-fidelity (presence + IoU + position agreement)
  mean_iou: number;
  matched: string[]; // expected labels the detector found
  missing: string[]; // expected labels with no detection
  extra: string[]; // detections that weren't expected
  repaired: boolean; // a corrective edit was applied + kept
  iterations: number;
}

// The edit loop's verdict on a mask-scoped edit (EDIT_REGION): what the
// critics saw on the kept attempt. Present on `final` only when the judged
// inpaint path ran (image_op === "inpaint" and the inputs were judgeable).
export interface EditVerdict {
  alignment: number | null; // 0-10: the asked change landed (inside crop)
  medium: number | null; // 0-10: the art medium held (style pair judge)
  outside_change: number | null; // 0-1 pixel fraction beyond the mask (free diff)
  attempts: number;
  accepted: boolean; // false = best-effort keep-best, gates not all met
}

export interface GenerateFinalEvent {
  type: "final";
  image_data_url: string;
  page_title: string;
  image_model: string;
  prompt_author_model: string;
  session_id: string;
  final_prompt: string;
  // Web-search citations the planner used. Empty when web search is off
  // or the model returned none. Already domain-deduped, capped at ~3.
  sources?: Citation[];
  // Which non-fresh image operation rendered this page ("zoom_continue",
  // "enter_scene"). Absent on the fresh path â additive, backwards-compat.
  image_op?: string;
  // Geometric grounding summary â present only when VLM_GROUNDING was on.
  grounding?: GroundingSummary;
  // Judged mask-scoped edit verdict â present only on the EDIT_REGION path.
  edit_verdict?: EditVerdict;
  // Running estimated spend ($) for this session — coarse, mirrors
  // docs/COSTS.md prices (providers/spend.py). Additive; absent on older
  // backends.
  session_spend_estimate?: number;
  trace_id?: string;
}

export interface GenerateErrorEvent {
  type: "error";
  message: string;
  trace_id?: string;
}

export type GenerateStage =
  | "click_resolving"
  | "click_resolved"
  | "planning"
  | "generating_image"
  // A fast-tier draft frame is about to land as `progress`; the main render
  // is still running and will replace it (PROGRESSIVE_DRAFT).
  | "draft"
  | "verifying";

export interface GenerateStatusEvent {
  type: "status";
  stage: GenerateStage;
  page_title?: string;
  subject?: string;
  // Resolver self-report when stage === "click_resolved". Web client can
  // render the bounding-box overlay or a "tap something specific?" toast
  // when groundable is false / confidence is low.
  groundable?: boolean;
  confidence?: number;
  point?: ResolveClickPoint | null;
  bbox?: ResolveClickBBox | null;
  trace_id?: string;
}

// One bloomed neighbour from an "expand outward" pass (mode: "expand").
// Streamed as each neighbour's page finishes generating, so the tray fills in
// progressively. The client persists each as a relation:"expand" child of the
// node that was expanded.
export interface GenerateNeighborEvent {
  type: "neighbor";
  subject: string;
  scale: ScaleKind;
  page_title: string;
  image_data_url: string;
  image_model: string;
  prompt_author_model: string;
  final_prompt: string;
  session_id: string;
  // Position within this bloom + how many were proposed, for tray ordering
  // and a "3 of 4" progress read.
  index: number;
  total: number;
  trace_id?: string;
}

// Terminal event of an expand bloom â the tray stops showing pending slots.
export interface GenerateExpandDoneEvent {
  type: "expand_done";
  count: number;
  trace_id?: string;
}

// OUTWARD (mode:"ascend"): the synthesized container image is ready; the client
// hands it to the /ascend route to persist the reparent. `scale_tier` is the
// container's rung, `from_tier` the source's.
export interface GenerateAscendReadyEvent {
  type: "ascend_ready";
  page_title: string;
  image_data_url: string;
  image_model: string;
  prompt_author_model: string;
  final_prompt: string;
  scale_tier: ScaleTier;
  from_tier: ScaleTier;
  session_id: string;
  trace_id?: string;
}

export type GenerateEvent =
  | GenerateStatusEvent
  | GenerateProgressEvent
  | GenerateFinalEvent
  | GenerateErrorEvent
  | GenerateNeighborEvent
  | GenerateExpandDoneEvent
  | GenerateAscendReadyEvent;

export interface NodeRecord {
  id: string;
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_url: string;
  image_model: string;
  prompt_author_model: string;
  created_at: string;
}

export interface NodeCreateRequest {
  parent_id: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_variants: Record<AspectRatio, string>;
  image_model: string;
  prompt_author_model: string;
}

export type LoopyStrategy = "anchor_loop" | "linear";

export interface LTXStreamStartMessage {
  action: "start";
  session_id: string;
  prompt: string;
  width: number;
  height: number;
  num_frames: number;
  frame_rate: number;
  max_segments: number;
  loopy_mode: boolean;
  loopy_strategy: LoopyStrategy;
  start_image: string;
  target_image: string;
  position: number;
}

export interface LTXStreamStopMessage {
  action: "stop";
  session_id: string;
}

export type LTXStreamMessage = LTXStreamStartMessage | LTXStreamStopMessage;

export interface LTXFHeader {
  media_type: string;
  sequence: number;
  is_init_segment?: boolean;
  final?: boolean;
}

export const LTXF_MAGIC = "LTXF" as const;

export const DEFAULTS = {
  aspectRatio: "16:9" as AspectRatio,
  videoWidth: 1920,
  videoHeight: 1088,
  numFrames: 49,
  frameRate: 24,
  loopyStrategy: "anchor_loop" as LoopyStrategy,
} as const;

// World-memory layer ---------------------------------------------------------
// A "world" is a session: as the user explores, the VLM extracts entities
// (people / places / items / creatures) from each newly-generated page. The
// extraction lives on the backend (providers/llm.py extract_entities), the
// registry persists in MongoDB on the web side (apps/web/lib/world.ts), and
// the UI surfaces it via a codex panel, in-image hover chips, and atlas pins.
// See docs/superpowers/specs/ or the plan file for the broader design.

export type EntityKind = "person" | "place" | "item" | "creature";

// Free-form key/value bag for causality (door=open, lantern=lit, mira_present=true).
// Kept loose on purpose â the extractor emits whatever verbs/state words fit
// the scene; the codex surface renders them as plain key:value chips.
export type EntityState = Record<string, string | number | boolean>;

// 0..1 normalized bounding box of an entity inside a page image. Top-left
// origin. Used by the in-image hover-chip overlay to position the tooltip; an
// entity's appearance count is independent of how many of its appearances have
// a bbox.
export interface EntityBBox {
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  aliases: string[];
  // Short visual descriptor that gets prepended to image-gen prompts when
  // this entity is referenced again. Should read like a sentence: "tall grey
  // lighthouse keeper in a navy peacoat, white braid, weathered hands".
  appearance: string;
  // R2 public URL of the first-seen crop of this entity. When present, the
  // image provider can use it as img2img conditioning for stronger continuity
  // than text descriptor alone. Null until web-side cropping lands.
  reference_image_url: string | null;
  facts: string[];
  state: EntityState;
  first_seen_node_id: string;
  last_seen_node_id: string;
  // Atlas tile ids (== node ids in the current world-layout) the entity has
  // appeared on. Used for the atlas-pin overlay.
  appears_on_node_ids: string[];
  // Sparse map of `node_id` â bounding box for the entity's appearance on
  // that node. Populated by the extractor when it can localize the entity
  // in the image; omitted otherwise. Hover chips read this when rendering
  // the current page; atlas pins can use it to place markers within a
  // tile. Older entities (pre-bbox extraction) simply have no entries
  // here and fall back to no-chip rendering.
  appearance_bboxes: Record<string, EntityBBox>;
  // Sparse map of node_id → SAM3 border polygon ([x,y] pairs, normalized 0..1
  // image space). Populated by extraction behind WORLD_SEGMENT_BORDERS; the geo
  // overlay draws a tight outline when present, else falls back to the bbox.
  appearance_borders?: Record<string, [number, number][]>;
  // User-pinned entries are never auto-deleted or auto-merged. Extractor
  // suggestions targeting a user-renamed entity get reconciled by alias.
  pinned_by_user: boolean;
  // Extractor's 0..1 self-rated confidence. Codex UI may dim entries below a
  // threshold and offer a "delete junk" sweep.
  confidence: number;
  updated_at: string;
}

// ââ Geometric world model ââââââââââââââââââââââââââââââââââââââââââââââââââââ
// A persistent 2D coordinate world: entities sit at numeric map positions with a
// height + footprint; an observer has a pose; a rendered scene is a VIEW of the
// in-frame entities from that pose (there is no single correct view). All
// additive + dormant until GEOMETRIC_WORLD is enabled. The geometry engine
// (apps/web/lib/world-geometry.ts â apps/modal-backend/providers/geometry.py)
// projects (map + observer) â the per-frame layout below.

// A point in world units (arbitrary scale; origin top-left, +x east, +y south).
export interface WorldVec2 {
  x: number;
  y: number;
}

// An entity placed on the map: where it is, how tall, how much ground it covers.
//
// Nested frames (the sub-entity consistency model): a place you can ENTER (the
// Unseen University) is its own little world. Its sub-entities (Tower of Art,
// Library, Great Hall) carry `parent_id` = that place's geo id, and their `pos`
// is LOCAL to the parent's frame â so the University's internal layout is fixed
// ONCE and stays consistent across every view of it, and editing one ripples to
// its siblings. Top-level city entities have `parent_id: null` (pos == world).
export interface WorldEntityGeo {
  id: string;
  // The Codex Entity.id this geometry belongs to, or null for a map-only prop.
  entity_id: string | null;
  // The geo id of the place this entity lives INSIDE (its sub-world), or null
  // for a top-level city-frame entity. `pos` is interpreted in the parent's
  // local frame; resolve up the chain for an absolute world position.
  parent_id?: string | null;
  kind: EntityKind;
  label: string;
  pos: WorldVec2;
  height: number; // world units, the entity's vertical extent (top = elevation+height)
  // Base elevation: world-z of the entity's foot above the ground plane. 0 (the
  // default) = sits on the ground; >0 lifts it (a bird aloft, a clifftop castle,
  // a wall-mounted lantern). The projector reads `elevation ?? 0`.
  elevation?: number;
  footprint: { w: number; d: number }; // ground extent: width (x) Ã depth (y)
  // Per-frame scale: the size of ONE unit of THIS place's INTERIOR frame, in its
  // parent's units (default 1). Set when the place is first entered (its
  // footprint extent Ã· the interior's local extent) so a child's local `pos`
  // resolves to a true absolute position INSIDE this place. Metric â distinct
  // from the categorical Entity.scale LOD bucket.
  scale?: number;
  // Coarse absolute rung on SCALE_LADDER (city / place / room â¦) â which order of
  // magnitude this entity's frame sits at, independent of the fine metric `scale`.
  // Optional; seeded by the view estimator, used by B2 scale navigation.
  scale_tier?: ScaleTier;
  heading?: number; // facing, radians, 0 = +x; optional
  visual: string; // short appearance descriptor (mirrors Entity.appearance)
  state: EntityState;
  confidence: number; // 0..1
  // How this geometry was set: "user" (hand-placed, authoritative), "extracted"
  // (a confirmed detection), or "derived" (back-projected from a bbox â a guess).
  source: "extracted" | "user" | "derived";
  updated_at: string;
  // VLM-segmented border polygon (B2 segmenter), in the SAME frame as `pos`
  // (the parent's local frame). 3..24 vertices; absent = only the rectangular
  // footprint is known. Persisted behind WORLD_SEGMENT_BORDERS.
  border?: WorldVec2[];
  // Inferred ABSOLUTE height in meters - from the segmenter's anchored
  // relative ladder, NOT from map pixels (map symbology is not metric).
  // Distinct from `height` (relative world units). Absent = not inferred.
  height_m?: number;
}

// Where the camera stands for a scene. Null observer â a top-down map view.
export interface ObserverPose {
  pos: WorldVec2;
  eye_height: number;
  gaze: number; // heading (yaw), radians, 0 = +x
  // Camera tilt, radians, 0 (default) = level / horizon-locked. +pitch looks UP
  // (the horizon drops on screen), -pitch looks down. The projector reads
  // `pitch ?? 0`. Lets a scene tilt up at a tower or down a slope.
  pitch?: number;
  fov: number; // horizontal field of view, radians
}

// A rectangular window into the world, in world units (sub-map crop / bounds).
export interface MapCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

// What level a scene renders at â there is no single correct view.
export type ViewLevel = "map" | "building" | "street" | "eye";

// Render-INTENT camera vocabulary (the view grammar). Distinct from
// ViewProjection below, which is the estimator's PERCEPTION read-out of an
// already-generated image (estimator "perspective" maps to "eye_level" here).
// A deliberate projection per render: flat 2D plan, 2.5D oblique bird's-eye,
// true isometric, or 3D eye-level â plus optional numeric camera params.
export type ViewSpecProjection = "top_down" | "oblique" | "isometric" | "eye_level";
export interface ViewSpec {
  projection: ViewSpecProjection;
  pitch_deg?: number; // camera tilt: -90 straight down â¦ 0 horizon
  azimuth_deg?: number; // compass bearing of the gaze, 0 = north
  // Qualitative register ("eye" â 1.7 world units) or a metric height.
  camera_height?: "ground" | "eye" | "rooftop" | "aerial" | number;
  fov_deg?: number;
  // Who decided this view: the per-place policy, an explicit user pick
  // (projection pills), or the view estimator's read of a generated image.
  source: "policy" | "user" | "estimated";
}

// The view a given node (scene) renders: its level + observer pose (non-map
// levels) and/or the map crop (map level). Persisted on the node.
export interface SceneView {
  node_id: string;
  level: ViewLevel;
  observer: ObserverPose | null;
  map_crop: MapCrop | null;
  // Closeup rung (tap descent ladder): this frame is a TIGHT zoom on
  // `focus_id` (the entity fills the view) — the next tap on that entity
  // TRANSITIONS (enters) instead of zooming again. Absent on plain submaps,
  // whose focus_id is just the nearest entity to an empty-area tap.
  closeup?: boolean;
  // The entity you ENTERED to get here (the tapped place). Its sub-entities seed
  // into this place's child frame (parent_id = its geo) so the interior layout
  // stays consistent across re-entries. Null for a top-level map view.
  focus_id?: string | null;
  // Coarse absolute rung on SCALE_LADDER for this view (DEEPER stamps childTier,
  // OUTWARD stamps parentTier) â so both directions share one ladder. Optional.
  scale_tier?: ScaleTier;
  // The deliberate camera for this render (the view grammar). Absent/null on
  // legacy nodes â the pre-grammar hardcoded behavior, byte-identical.
  view?: ViewSpec | null;
  // How many times this place has already been entered (the client's revisit
  // count). >0 rotates the scene camera to another angle under
  // ENTER_AZIMUTH_ROTATE; absent/0 is byte-identical.
  enter_index?: number | null;
}

// One entity's projected place in a rendered frame (geometry-engine output),
// 0..1 normalized in the frame. Drives prompt constraints + VLM verification.
export interface ProjectedEntity {
  id: string;
  label: string;
  x_pct: number; // screen centre
  y_pct: number;
  w_pct: number; // apparent size
  h_pct: number;
  depth: number; // distance from observer; lower = nearer (drawn on top)
  // Coarse bins â what prompts + the VLM judge actually consume (honest: bins,
  // not pixels). h_pos â far-left..far-right, v_pos â top|mid|bottom, size bin.
  h_pos: string;
  v_pos: string;
  size: string;
}

// What the camera estimator reads out of a generated image, so the geometry
// layer doesn't assume top-down. `projection` decides how a detection
// box back-projects: top_down â the box is a footprint; oblique/perspective â
// its vertical extent reads as apparent height.
export type ViewProjection = "top_down" | "oblique" | "perspective";
export interface ViewEstimate {
  level: ViewLevel;
  projection: ViewProjection;
  pitch_deg: number;
  // Coarse SCALE_LADDER rung the estimator read (or the ViewLevelâtier fallback).
  // Optional; mirrored in the Python ViewEstimate TypedDict (view_estimator.py).
  scale_tier?: ScaleTier;
  // The estimator's own 0..1 confidence. Gates the C12 node PATCH backend-side
  // (>= 0.7); optional for older payloads.
  confidence?: number;
}

// A per-session snapshot of the geometric world (the `world_map` collection).
export interface WorldMapSnapshot {
  session_id: string;
  entities: WorldEntityGeo[];
  bounds: MapCrop;
  schema_version: number;
  updated_at: string;
}

// Backend â web wire format for one extraction pass. The web layer takes
// this, allocates ids for `added`, merges into the WorldStateDoc, emits
// SSE events to subscribed frontends. State changes ride inside
// `updated[].changes.state` rather than a separate channel; kept simple
// until causality phase needs a richer shape.
export interface ExtractedEntity {
  kind: EntityKind;
  name: string;
  aliases?: string[];
  appearance: string;
  facts?: string[];
  state?: EntityState;
  confidence: number;
  // Optional bounding box in 0..1 normalized image coords for in-image
  // hover chips. Omitted when the extractor can't localize the entity.
  bbox?: { x_pct: number; y_pct: number; w_pct: number; h_pct: number } | null;
  // SAM3 border polygon ([x,y] pairs, 0..1 image space) when the extractor
  // segmented the entity (WORLD_SEGMENT_BORDERS). Omitted otherwise.
  border?: [number, number][] | null;
}

export interface EntityUpdate {
  // Match by name first, fall back to alias. Web layer resolves to an id.
  match_name: string;
  changes: Partial<Pick<Entity, "name" | "appearance" | "facts" | "state" | "aliases">>;
  confidence: number;
  // Re-localized box on THIS node: a recurring entity is detected again so it
  // keeps an appearance_bbox per node â without it, geometry/overlay drop the
  // entity on every re-appearance. Omitted when localization fails.
  bbox?: { x_pct: number; y_pct: number; w_pct: number; h_pct: number } | null;
  border?: [number, number][] | null;  // SAM3 polygon, same shape as ExtractedEntity
}

export interface EntityExtractionResult {
  added: ExtractedEntity[];
  updated: EntityUpdate[];
}

export interface ExtractEntitiesRequestBody {
  session_id: string;
  node_id: string;
  image_data_url: string;
  caption: string;
  // Lightweight summary of the world's current entities so the VLM can
  // diff. Web side selects the most relevant slice (recent + name-overlap
  // candidates) before sending â full registry on every call wastes tokens.
  prior_entities: Array<Pick<Entity, "id" | "kind" | "name" | "aliases" | "appearance">>;
  trace_id?: string;
}

export interface ExtractEntitiesResponse {
  result: EntityExtractionResult;
  trace_id?: string;
}

// Snapshot returned by GET /api/world/:sessionId â used to hydrate the
// codex panel and the atlas overlay on permalink load.
export interface WorldStateSnapshot {
  session_id: string;
  entities: Entity[];
  updated_at: string;
}

// User-override CRUD on the codex. `undo_delete` restores a soft-deleted entity
// within the undo window the codex panel exposes.
export type WorldEntityMutation =
  | { op: "create"; entity: Omit<Entity, "id" | "updated_at"> }
  | { op: "rename"; id: string; name: string; aliases?: string[] }
  | { op: "merge"; source_id: string; target_id: string }
  | { op: "delete"; id: string }
  | { op: "undo_delete"; id: string }
  | { op: "pin"; id: string; pinned: boolean }
  | { op: "set_appearance"; id: string; appearance: string; reference_image_url?: string | null };

// ââ Geometry edits: NL-editable map ââââââââââââââââââââââââââââââââââââââââââ
// A structured edit to the geometric world map (WorldEntityGeo by id). These are
// what `edit_entities_nl` turns a natural-language instruction into ("move the
// lighthouse north" â {op:"move", target, dx, dy}). `target` is a WorldEntityGeo
// id; deltas are op-specific and in world units. Applied by lib/world-map.ts.
export type EntityGeoEdit =
  | { op: "move"; target: string; dx: number; dy: number }
  | { op: "set_height"; target: string; height: number }
  | { op: "set_appearance"; target: string; visual: string }
  | { op: "remove"; target: string }
  | {
      op: "add";
      label: string;
      pos: WorldVec2;
      height?: number;
      footprint?: { w: number; d: number };
    };

// The result of an NL edit: the structured ops plus the blast-radius â the node
// ids whose saved render references an edited entity and so are now stale (the
// codex can offer "editing this restages N scenes â restage now?").
export interface EntityEditPlan {
  edits: EntityGeoEdit[];
  blast_radius: string[];
}

export interface EditEntitiesRequestBody {
  session_id: string;
  instruction: string;
  // The geo entities the editor may target (current map state, trimmed).
  entities: Array<
    Pick<
      WorldEntityGeo,
      "id" | "entity_id" | "label" | "pos" | "height" | "footprint" | "visual"
    >
  >;
  // geo-id â node ids that show it; lets the backend compute blast-radius
  // without the full codex registry (web side builds it from appears_on_node_ids).
  references?: Record<string, string[]>;
  scene_view?: SceneView | null;
  trace_id?: string;
}

export interface EditEntitiesResponse {
  plan: EntityEditPlan;
  trace_id?: string;
}

// ââ Describe a place -> logical object world (WORLD_FROM_DESCRIPTION) âââââââââ
// Turn a natural-language place description into all its objects on the shared 2D
// plane. The planner emits STRUCTURE (entities + relations), NEVER coordinates â
// the deterministic solver (providers/layout_solver.py) turns relations into
// WorldEntityGeo positions. All additive + flag-gated; no existing type changes.

// Relations the planner may express between two refs. Never coordinates.
export type SpatialRelation =
  | "near"
  | "on_wall"
  | "behind"
  | "in_front_of"
  | "left_of"
  | "right_of"
  | "inside"
  | "on_top_of"
  | "facing";

// One named / functionally-implied object. `ref` is the stable slug relations
// point at; `visual` is one render-ready sentence (the extractor's appearance
// contract). `count` fans out into N instances at solve time.
export interface PlannedEntity {
  ref: string;
  kind: EntityKind;
  label: string;
  visual: string;
  footprint?: { w: number; d: number };
  height?: number;
  count?: number;
}

// A placement constraint: `subject` is positioned relative to `object`.
export interface PlannedRelation {
  subject: string;
  relation: SpatialRelation;
  object: string;
  gap?: number;
}

// A region the description explicitly says is empty / clear / reserved. The
// solver keeps every footprint out of its AABB; the renderer gets a negative
// clause. `approx` (0..1 of the place) is an optional hint box.
export interface EmptyRegion {
  ref: string;
  note: string;
  approx?: { x: number; y: number; w: number; h: number };
}

// The structured read of the description (tolerant-parsed; malformed members are
// dropped). `contradictions` non-empty -> blocking; `clarifiers` (<=2) are the
// questions to ask. Both empty -> the graph is solvable as-is.
export interface SceneGraph {
  place_label: string;
  place_kind: EntityKind;
  bounds_hint?: { w: number; h: number };
  entities: PlannedEntity[];
  relations: PlannedRelation[];
  empty_regions: EmptyRegion[];
  clarifiers: string[];
  contradictions: string[];
}

export interface PlanWorldResponse {
  graph: SceneGraph;
  // The solved layout (ready for upsertEntityGeos), or null when the graph is
  // blocked (hard contradiction / unresolved blocking clarifier) -> the client asks.
  solved: WorldEntityGeo[] | null;
  trace_id?: string;
}

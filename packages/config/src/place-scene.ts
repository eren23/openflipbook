export type PlaceComponent = "pond" | "bench" | "pergola" | "path" | "wall" | "tree" | "tavern" | "house" | "well" | "barrels" | "mesh" | "building" | "volume";
export type BuildingSide = "north" | "east" | "south" | "west";
export type BuildingSurface = "wall" | "floor" | "roof" | "ceiling" | "stair";
export interface SurfaceMaterial {
  asset_id: string;
  tile_metres: number;
  rotation: number;
  roughness: number;
}
export interface BuildingOpening {
  id: string;
  side: BuildingSide;
  wall_id?: string;
  offset: number;
  width: number;
  height: number;
  sill: number;
  floor: number;
}
export interface BuildingStructure {
  wall_thickness: number;
  roof_height: number;
  // Clockwise orthogonal outline in normalized building-local x/z (-0.5..0.5).
  // Each vertex identifies the outgoing wall. Absent retains the legacy box.
  footprint?: { id: string; x: number; z: number }[];
  floors: { id: string; label: string; layout?: RoomLayout }[];
  door: BuildingOpening;
  windows: BuildingOpening[];
  // Optional for legacy compatibility. Centre is building-local; direction is
  // the direction of ascent. Width/rise/run are derived, never stored twice.
  stair?: { id: string; x: number; z: number; direction: BuildingSide };
}
// Partition positions and doorway offsets use the building's local metre frame.
export type RoomLayout = { type: "room"; id: string; label: string } | {
  type: "split"; id: string; axis: "x" | "z"; position: number;
  door: { id: string; offset: number; width: number; height: number };
  a: RoomLayout; b: RoomLayout;
};
export interface PlaceSceneObject {
  id: string;
  entity_id: string;
  kind: PlaceComponent;
  label: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  heading: number;
  color: string;
  // Bound furnishings use building-centred local x/z and relative heading.
  // Their elevation is derived from the identified floor, never stored twice.
  placement?: { building_id: string; floor_id: string };
  structure?: BuildingStructure;
  // Mesh geometry, optionally bound to an explicitly authored building shell.
  // Server preview validates actual triangles against the shell's free space.
  asset_id?: string;
  // Missing means legacy independent-axis sizing; never reinterpret saved scenes.
  mesh_scale?: "uniform" | "stretch";
  // Source-axis quarter-turns (0..3), XYZ Euler, before sizing and placement heading.
  mesh_orientation?: { x: number; y: number; z: number };
  mesh_role?: "prop" | "exterior";
  materials?: Partial<Record<BuildingSurface, SurfaceMaterial>>;
  drawing_element_id?: string;
  eave_height?: number;
  roof_offset?: number;
  roof_material?: "terracotta" | "teal";
}
export interface PlaceSceneDefinition {
  version: 1 | 2;
  label: string;
  width: number;
  depth: number;
  units: "authored_metres";
  objects: PlaceSceneObject[];
  entrance: { x: number; z: number; yaw: number };
  material_pack?: "ankh-street-v1";
  ground_material?: SurfaceMaterial;
}
export interface PlaceSceneSnapshot {
  id: string;
  session_id: string;
  place_id: string;
  revision: number;
  source_node_id: string | null;
  source_image_key: string | null;
  definition: PlaceSceneDefinition;
  updated_at: string;
  generation_sources?: SceneGenerationReceipt[];
}
export interface PlaceBuildFloorTarget { building_id: string; floor_id: string }
export interface SceneGenerationReceipt {
  job_id: string;
  model: string;
  request_id: string | null;
  prompt: string;
  base_revision: number;
  input_sha256: string;
  connection_input?: PlaceBuildConnectionInput;
  connections_sha256?: string;
  target_floor?: PlaceBuildFloorTarget;
  object_ids: string[];
  reserved_usd: number;
  created_at: string;
}
export interface WorldEditProposal {
  id: string;
  scene_id: string;
  base_revision: number;
  definition: PlaceSceneDefinition;
  affected_node_ids: string[];
  changes: string[];
  applied_revision?: number;
  connection?: PlaceConnection;
  generation_job_id?: string;
}

export interface PlaceConnection {
  id: string;
  version: 1;
  kind: "boundary";
  a: { place_id: string; side: BuildingSide; offset: number };
  b: { place_id: string; side: BuildingSide; offset: number };
  width: number;
  created_at: string;
}

export interface PlaceBuildConnectionInput {
  version: 1;
  place_id: string;
  connections: PlaceConnection[];
}

export interface ConnectedPlaceChunk {
  scene: PlaceSceneSnapshot;
  // Runtime offset derived from the canonical world-map frame, never stored
  // as an independent placement authority. Three.js uses x/east, z/south.
  x: number;
  z: number;
}
export interface PlaceNetwork {
  chunks: ConnectedPlaceChunk[];
  connections: PlaceConnection[];
}

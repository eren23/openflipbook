import type { BuildingSide, ConnectedPlaceChunk, PlaceConnection, PlaceNetwork, PlaceSceneDefinition, PlaceSceneSnapshot, WorldEntityGeo } from "@openflipbook/config";
import type { Solid } from "./place-physics";

export const OPPOSITE_SIDE: Record<BuildingSide, BuildingSide> = { north: "south", south: "north", east: "west", west: "east" };
const EPS = 0.001;
const safe = (s: unknown): s is string => typeof s === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
export const edgeLength = (d: PlaceSceneDefinition, side: BuildingSide) => side === "north" || side === "south" ? d.width : d.depth;

export function placeFrame(scene: PlaceSceneSnapshot, geos: WorldEntityGeo[]) {
  const geo = geos.find(g => g.id === scene.place_id);
  if (!geo || ![geo.heading??0,geo.elevation??0,geo.scale??1,geo.footprint.w,geo.footprint.d].every(Number.isFinite) || geo.scene_id !== scene.id || geo.parent_id || Math.abs(geo.heading ?? 0) > EPS || Math.abs(geo.elevation ?? 0) > EPS || Math.abs((geo.scale ?? 1) - 1) > EPS || Math.abs(geo.footprint.w - scene.definition.width) > EPS || Math.abs(geo.footprint.d - scene.definition.depth) > EPS) throw new Error("Boundary connections require ground-level, axis-aligned places in authored metres");
  if (![geo.pos.x, geo.pos.y].every(Number.isFinite)) throw new Error("Invalid place frame");
  return { x: geo.pos.x - geo.footprint.w / 2, z: geo.pos.y - geo.footprint.d / 2 };
}

export function adjacentPlacement(source: PlaceSceneSnapshot, target: PlaceSceneSnapshot, side: BuildingSide, geos: WorldEntityGeo[]): WorldEntityGeo {
  if (!Object.hasOwn(OPPOSITE_SIDE, side)) throw new Error("Choose a boundary direction");
  const origin = placeFrame(source, geos), a = source.definition, b = target.definition;
  const x = origin.x + a.width / 2 + (side === "east" ? (a.width+b.width)/2 : side === "west" ? -(a.width+b.width)/2 : 0);
  const z = origin.z + a.depth / 2 + (side === "south" ? (a.depth+b.depth)/2 : side === "north" ? -(a.depth+b.depth)/2 : 0);
  for (const g of geos.filter(g => g.kind === "place" && !g.parent_id)) {
    if (Math.abs(g.pos.x-x) < (g.footprint.w+b.width)/2-EPS && Math.abs(g.pos.y-z) < (g.footprint.d+b.depth)/2-EPS) throw new Error("The adjoining area overlaps an existing place");
  }
  return { id: target.place_id, entity_id: `entity_${target.place_id}`, kind: "place", label: b.label, pos: {x,y:z},
    footprint: {w:b.width,d:b.depth}, height:0, scale:1, scene_id:target.id, source:"user", confidence:1,
    state:{}, visual:`Authored ${b.label}`, updated_at:target.updated_at };
}

function boundaryPoint(d: PlaceSceneDefinition, side: BuildingSide, offset: number) {
  return { x: side === "west" ? 0 : side === "east" ? d.width : offset,
    z: side === "north" ? 0 : side === "south" ? d.depth : offset };
}

export function connectionApproach(d: PlaceSceneDefinition, end: PlaceConnection["a"], width: number) {
  if (!Object.hasOwn(OPPOSITE_SIDE, end.side) || !Number.isFinite(width) || width < 1.2 || width > 20
    || !Number.isFinite(end.offset) || end.offset-width/2 < 0.5 || end.offset+width/2 > edgeLength(d,end.side)-0.5) throw new Error("Connection opening extends beyond its boundary");
  const p = boundaryPoint(d, end.side, end.offset), alongX = end.side === "north" || end.side === "south";
  const x = p.x + (end.side === "west" ? 0.5 : end.side === "east" ? -0.5 : 0);
  const z = p.z + (end.side === "north" ? 0.5 : end.side === "south" ? -0.5 : 0);
  for (const o of d.objects.filter(o => o.kind !== "path" && !o.placement)) {
    const co = Math.abs(Math.cos(o.heading)), si = Math.abs(Math.sin(o.heading));
    if (Math.abs(o.x-x) < (o.width*co+o.depth*si)/2+(alongX?width/2:0.5)+0.05 && Math.abs(o.z-z) < (o.width*si+o.depth*co)/2+(alongX?0.5:width/2)+0.05) throw new Error(`Connection approach is blocked by ${o.label}`);
  }
  return { x, z };
}

export function validatePlaceConnection(c: PlaceConnection, scenes: PlaceSceneSnapshot[], geos: WorldEntityGeo[]) {
  if (!c || !safe(c.id) || c.version !== 1 || c.kind !== "boundary" || !c.a || !c.b || c.a.place_id === c.b.place_id || !safe(c.a.place_id) || !safe(c.b.place_id) || !Number.isFinite(c.width) || c.width < 1.2 || c.width > 20 || !Object.hasOwn(OPPOSITE_SIDE, c.a.side) || c.b.side !== OPPOSITE_SIDE[c.a.side]) throw new Error("Invalid boundary connection");
  const points = [c.a, c.b].map(end => {
    const scene = scenes.find(s => s.place_id === end.place_id);
    if (!scene) throw new Error("Connected place is missing");
    const d = scene.definition, frame = placeFrame(scene, geos);
    const p = boundaryPoint(d,end.side,end.offset);
    // Reserve a full metre of approach on each side. Rectangular conservative
    // clearance is deliberate here; indoor doorway portals are a separate kind.
    connectionApproach(d, end, c.width);
    return {x:frame.x+p.x,z:frame.z+p.z};
  });
  if (Math.hypot(points[0]!.x-points[1]!.x,points[0]!.z-points[1]!.z) > EPS) throw new Error("Connected boundaries no longer align");
}

export function validateConnections(connections: PlaceConnection[], scenes: PlaceSceneSnapshot[], geos: WorldEntityGeo[]) {
  const ids = new Set<string>();
  for (const c of connections) {
    if (ids.has(c.id)) throw new Error("Duplicate connection identity"); ids.add(c.id);
    validatePlaceConnection(c,scenes,geos);
  }
}

export function placeNetwork(root: string, scenes: PlaceSceneSnapshot[], geos: WorldEntityGeo[], connections: PlaceConnection[]): PlaceNetwork | null {
  const reachable = new Set([root]);
  for (let changed=true; changed;) {
    changed=false;
    for (const c of connections) if (reachable.has(c.a.place_id) || reachable.has(c.b.place_id)) for (const p of [c.a.place_id,c.b.place_id]) if (!reachable.has(p)) {reachable.add(p);changed=true;}
  }
  if (reachable.size === 1) return null;
  if (reachable.size > 16) throw new Error("Connected walk currently supports up to 16 places");
  const links = connections.filter(c => reachable.has(c.a.place_id));
  const members = scenes.filter(s => reachable.has(s.place_id));
  if (members.length !== reachable.size) throw new Error("Connected place is missing");
  validateConnections(links,members,geos);
  const chunks = members.map(scene => ({scene,...placeFrame(scene,geos)}));
  if (chunks.reduce((sum,c)=>sum+c.scene.definition.objects.length,0)>1000) throw new Error("Connected walk exceeds 1000 objects");
  return {chunks,connections:links};
}

export function networkView(network: PlaceNetwork, root: string) {
  const minX = Math.min(...network.chunks.map(c=>c.x)), minZ = Math.min(...network.chunks.map(c=>c.z));
  const width = Math.max(...network.chunks.map(c=>c.x+c.scene.definition.width))-minX;
  const depth = Math.max(...network.chunks.map(c=>c.z+c.scene.definition.depth))-minZ;
  const chunks = network.chunks.map(c=>({...c,x:c.x-minX,z:c.z-minZ}));
  const start = chunks.find(c=>c.scene.place_id===root);
  if (!start) throw new Error("Starting place is not loaded");
  const definition: PlaceSceneDefinition = { version:2,units:"authored_metres",label:start.scene.definition.label,width,depth,
    entrance:{...start.scene.definition.entrance,x:start.x+start.scene.definition.entrance.x,z:start.z+start.scene.definition.entrance.z},
    objects:chunks.flatMap(c=>c.scene.definition.objects.map(o=>o.placement?o:({...o,x:c.x+o.x,z:c.z+o.z}))) };
  return {chunks,definition};
}

export function networkBoundarySolids(chunks: ConnectedPlaceChunk[], connections: PlaceConnection[]): Solid[] {
  const solids: Solid[] = [];
  for (const chunk of chunks) for (const side of Object.keys(OPPOSITE_SIDE) as BuildingSide[]) {
    const d = chunk.scene.definition, alongX = side === "north" || side === "south";
    const holes = connections.flatMap(c=>[c.a,c.b].filter(e=>e.place_id===chunk.scene.place_id&&e.side===side).map(e=>[e.offset-c.width/2,e.offset+c.width/2] as const)).sort((a,b)=>a[0]-b[0]);
    let from=0;
    const wall=(to:number)=>{
      if(to-from>EPS){ const p=boundaryPoint(d,side,(from+to)/2); solids.push({x:chunk.x+p.x,y:15,z:chunk.z+p.z,w:alongX?to-from:0.08,d:alongX?0.08:to-from,h:30,yaw:0}); }
    };
    for (const [lo,hi] of holes) {wall(lo);from=Math.max(from,hi);}
    wall(edgeLength(d,side));
  }
  return solids;
}

export function networkPlaceAt(chunks: ConnectedPlaceChunk[], x: number, z: number) {
  return chunks.find(c=>x>=c.x-EPS && x<=c.x+c.scene.definition.width+EPS && z>=c.z-EPS && z<=c.z+c.scene.definition.depth+EPS)?.scene.place_id ?? null;
}

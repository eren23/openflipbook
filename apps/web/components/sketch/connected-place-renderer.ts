import type { PlaceNetwork } from "@openflipbook/config";
import { networkBoundarySolids, networkView } from "@/lib/place-connections";
import { buildPlaceScene, THREE } from "./place-scene-renderer";

export function buildConnectedPlaces(network: PlaceNetwork, root: string) {
  const {chunks,definition}=networkView(network,root);
  const built=buildPlaceScene({...definition,objects:[]},{ground:false});
  const parts=chunks.map(chunk=>{
    const part=buildPlaceScene(chunk.scene.definition);
    // Keep one global daylight rig; room lights remain inside their buildings.
    for(const child of [...part.scene.children])if(child instanceof THREE.Light){part.scene.remove(child);child.dispose();}
    part.scene.position.set(chunk.x,0,chunk.z);built.scene.add(part.scene);
    built.solids.push(...part.solids.map(s=>({...s,x:s.x+chunk.x,z:s.z+chunk.z})));
    return {scene:part.scene,definition:chunk.scene.definition};
  });
  const boundaries=networkBoundarySolids(chunks,network.connections);
  built.solids.push(...boundaries);
  // Thin edge markers indicate the traversal limit of loaded authored ground.
  // They are editor boundaries, not additions to the persistent architecture.
  const material=new THREE.LineBasicMaterial({color:"#af735f",transparent:true,opacity:0.45});
  for(const b of boundaries){
    const points=b.w>b.d?[new THREE.Vector3(b.x-b.w/2,0.04,b.z),new THREE.Vector3(b.x+b.w/2,0.04,b.z)]:[new THREE.Vector3(b.x,0.04,b.z-b.d/2),new THREE.Vector3(b.x,0.04,b.z+b.d/2)];
    built.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),material));
  }
  return {...built,parts,chunks,definition};
}

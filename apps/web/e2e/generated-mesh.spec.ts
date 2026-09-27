import {expect, test} from "@playwright/test";
import * as THREE from "three";

test.skip(process.env.E2E_GENERATED_MESH !== "1", "Loads a fixture GLB in the Sketch editor (needs NEXT_PUBLIC_SKETCH_ENABLED=1); no model calls");

// A labelled geometry fixture exercises the real GLB loader, not model quality.
function fixtureGlb() {
  const geometry = new THREE.BoxGeometry(2, 4, 3).toNonIndexed();
  const positions = Buffer.from(geometry.attributes.position!.array.buffer);
  const normals = Buffer.from(geometry.attributes.normal!.array.buffer);
  const binary = Buffer.concat([positions, normals]);
  const source = {asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,NORMAL:1},material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[0.05,0.65,0.45,1],metallicFactor:0,roughnessFactor:0.6}}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.length},{buffer:0,byteOffset:positions.length,byteLength:normals.length}],accessors:[{bufferView:0,componentType:5126,count:36,type:"VEC3",min:[-1,-2,-1.5],max:[1,2,1.5]},{bufferView:1,componentType:5126,count:36,type:"VEC3"}]};
  const json = Buffer.from(JSON.stringify(source)), length = Math.ceil(json.length/4)*4;
  const out = Buffer.alloc(28+length+binary.length,32);
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);
  out.writeUInt32LE(length,12);out.writeUInt32LE(0x4e4f534a,16);json.copy(out,20);
  out.writeUInt32LE(binary.length,20+length);out.writeUInt32LE(0x004e4942,24+length);binary.copy(out,28+length);
  geometry.dispose();return out;
}

for (const width of [1280,390]) test(`generated GLB viewer and placement at ${width}`,async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const generation:string[]=[];
  await page.route("**/api/generate-page",r=>{generation.push(r.request().url());return r.abort();});
  const definition={version:1,label:"TEST FIXTURE - mesh integration",width:20,depth:20,units:"authored_metres",entrance:{x:10,z:18.8,yaw:0},objects:[]};
  await page.route("**/api/world/scene-context?*",r=>r.fulfill({json:{session_id:"mesh_test",place_id:"place",source_node_id:"test",source_url:"",initial:definition,scene:{id:"fixture_scene",session_id:"mesh_test",place_id:"place",source_node_id:"test",source_image_key:null,revision:1,updated_at:"2026-09-12T00:00:00.000Z",definition},history:[],drawing:null}}));
  await page.route("**/api/world/mesh_test/places/place/connections", r => r.fulfill({ json: { network: null } }));
  await page.route("**/api/world/mesh_test/places/place/views", r => r.fulfill({ json: { views: [] } }));
  await page.route("**/api/creator/worlds/mesh_test/walk", r => r.fulfill({ json: { revision: 0, pose: null } }));
  await page.route("**/api/world/mesh_test/places/place/build", r => {
    expect(r.request().method()).toBe("GET");
    return r.fulfill({ json: { jobs: [], capabilities: { enabled: false, reason: "TEST FIXTURE - layout generation blocked" } } });
  });
  await page.route("**/api/world/mesh_test/meshes",r=>{
    expect(r.request().method()).toBe("GET");
    return r.fulfill({json:{capabilities:{enabled:false,reservation:0,reason:"TEST FIXTURE - paid generation blocked"},jobs:[{id:"fixture",prompt:"TEST FIXTURE - not AI output",model:"test",status:"ready",reservation:0,asset_id:"mesh_fixture"}]}});
  });
  await page.route("**/api/world/mesh_test/meshes/mesh_fixture*",r=>new URL(r.request().url()).searchParams.has("geometry") ? r.fulfill({ json: { size: { width: 2, height: 4, depth: 3 } } }) : r.fulfill({contentType:"model/gltf-binary",body:fixtureGlb()}));
  await page.setViewportSize({width,height:width===390?844:900});
  await page.goto("/sketch/world?source=test&view=split");
  await expect(page.getByRole("button",{name:"Generate mesh",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Place in scene",exact:true}).click();
  for(const view of await page.getByTestId("place-viewport").all()) await expect(view).toHaveAttribute("data-ready","true");
  await expect(page.getByRole("button",{name:"TEST FIXTURE - not AI output mesh",exact:true})).toHaveAttribute("aria-pressed","true");
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Object width", { exact: true })).toHaveValue("1.5");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("2.25");
  await page.getByLabel("Object width", { exact: true }).fill("2");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("3");
  await page.getByLabel("Stretch mesh", { exact: true }).check();
  await page.getByLabel("Object depth", { exact: true }).fill("2");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("4");
  await page.getByLabel("Stretch mesh", { exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Object width", { exact: true })).toHaveValue("1.333");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("2.667");
  await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
  await page.getByLabel("Stretch mesh", { exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Object width", { exact: true })).toHaveValue("2");
  await page.getByLabel("Source pitch", { exact: true }).selectOption("1");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("4");
  await page.getByLabel("Stretch mesh", { exact: true }).check();
  await page.getByLabel("Object depth", { exact: true }).fill("3");
  await page.getByLabel("Stretch mesh", { exact: true }).click();
  await expect(page.getByLabel("Stretch mesh", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Object width", { exact: true })).toHaveValue("1.5");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("2.25");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("3");
  await page.getByRole("button", { name: "Reset mesh source orientation" }).click();
  await expect(page.getByLabel("Source pitch", { exact: true })).toHaveValue("0");
  await expect(page.getByLabel("Object height", { exact: true })).toHaveValue("3");
  await expect(page.getByLabel("Object depth", { exact: true })).toHaveValue("2.25");
  await page.getByRole("button", { name: "Undo draft edit", exact: true }).click();
  await expect(page.getByLabel("Source pitch", { exact: true })).toHaveValue("1");
  const region=page.getByRole("region",{name:"Live 3D",exact:true}), canvas=region.locator("canvas");
  await expect(region.getByTestId("place-viewport")).toHaveAttribute("data-ready", "true");
  await region.scrollIntoViewIfNeeded();
  await expect.poll(()=>canvas.evaluate(el=>{
    const c=document.createElement("canvas");c.width=c.height=100;const ctx=c.getContext("2d")!;ctx.drawImage(el as HTMLCanvasElement,0,0,100,100);
    const bytes=ctx.getImageData(0,0,100,100).data;let n=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i+1]!>bytes[i]!*1.3&&bytes[i+1]!>bytes[i+2]!*1.1)n++;return n;
  })).toBeGreaterThan(100);
  const viewport=region.getByTestId("place-viewport"), before=await viewport.getAttribute("data-camera");
  const rect=await canvas.boundingBox();expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x+rect!.width*.5,rect!.y+rect!.height*.5);await page.mouse.down();await page.mouse.move(rect!.x+rect!.width*.65,rect!.y+rect!.height*.52,{steps:20});await page.mouse.up();
  await expect.poll(()=>viewport.getAttribute("data-camera")).not.toBe(before);
  await page.screenshot({path:`test-results/generated-mesh-${width}.png`,fullPage:true});
  await page.getByRole("group", { name: "Mesh source orientation", exact: true }).screenshot({ path: `test-results/mesh-source-controls-${width}.png` });
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);expect(generation).toEqual([]);
  await expect(page.getByRole("alert").filter({ hasText: /.+/ })).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { MongoClient } from "mongodb";
import JSZip from "jszip";

test.skip(process.env.E2E_CONNECTED_PLACES!=="1","Real owned-world boundary creation and walking; no model calls");
for(const width of [1280,390])test(`connected places persist and traverse without a scene swap at ${width}`,async({page,browser,baseURL})=>{
  if(!baseURL||!["localhost","127.0.0.1"].includes(new URL(baseURL).hostname))throw new Error("Local server required");
  process.loadEnvFile(".env.local");
  const client=new MongoClient(process.env.MONGODB_URI!);await client.connect();const db=client.db(process.env.MONGODB_DB),created:string[]=[],errors:string[]=[],paid:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("response",async r=>{if(r.ok()&&r.request().method()==="POST"&&["/api/creator/worlds"].includes(new URL(r.url()).pathname)){const data=await r.json();if(data.session_id)created.push(data.session_id);}});
  await page.route(/\/api\/(generate-page|sketches\/[^/]+\/generate|world\/[^/]+\/meshes)/,route=>{if(route.request().method()!=="GET"){paid.push(route.request().url());return route.abort();}return route.continue();});
  const viewport=page.getByTestId("place-viewport"),ready=()=>expect(viewport).toHaveAttribute("data-ready","true");
  const camera=async()=>(await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const apply=async(revision:number)=>{await page.getByRole("button",{name:"Preview",exact:true}).click();await page.getByRole("button",{name:"Apply to world",exact:true}).click();await expect(page.getByRole("status").filter({hasText:`Revision ${revision}`})).toHaveText(`Revision ${revision} · Saved`);await ready();};
  try{
    await page.setViewportSize({width,height:width===390?844:900});await page.goto("/sketch/world");await ready();
    await page.getByRole("textbox",{name:"Place name",exact:true}).fill("Foundry square");
    await page.getByRole("spinbutton",{name:"Place width",exact:true}).fill("12");await page.getByRole("spinbutton",{name:"Place depth",exact:true}).fill("12");
    await page.getByText("Entrance",{exact:true}).click();
    await page.getByRole("spinbutton",{name:"Entrance x",exact:true}).fill("10.5");await page.getByRole("spinbutton",{name:"Entrance z",exact:true}).fill("6");
    await page.getByRole("combobox",{name:"Component type"}).selectOption("building");await page.getByRole("button",{name:"Add object",exact:true}).click();
    await page.getByRole("spinbutton",{name:"Object x",exact:true}).fill("4");
    await page.getByRole("checkbox",{name:"Confirm authored dimensions"}).check();await apply(1);
    const sourceUrl=new URL(page.url()),sid=sourceUrl.searchParams.get("world")!,pid=sourceUrl.searchParams.get("place")!;
    if(!created.includes(sid))created.push(sid);
    const sourceBefore=await db.collection("place_scenes").findOne({session_id:sid,place_id:pid});
    await page.getByText("Add adjoining area",{exact:true}).click();
    await page.getByRole("textbox",{name:"Adjoining area name"}).fill("Canal yard");
    await page.getByRole("button",{name:"Expand east",exact:true}).click();
    let releasePreview!:()=>void;
    const previewGate=new Promise<void>(resolve=>{releasePreview=resolve;});
    await page.route(`**/api/world/${sid}/places/${pid}/connections`,async route=>{
      if(route.request().method()==="POST")await previewGate;
      await route.continue();
    });
    await page.getByRole("button",{name:"Preview adjoining area",exact:true}).click();
    try{
      await expect(page.locator("aside")).toHaveAttribute("inert","");
      await expect(page.getByRole("navigation",{name:"Place view"}).locator("..")).toHaveAttribute("inert","");
    }finally{releasePreview();}
    await expect(page.getByRole("region",{name:"Connection preview"})).toContainText("east boundary");
    await expect(page.locator("aside")).not.toHaveAttribute("inert");
    expect(await db.collection("place_connections").countDocuments({session_id:sid})).toBe(0);
    await page.getByRole("button",{name:"Apply adjoining area",exact:true}).click();
    await expect(page.getByRole("combobox",{name:"Connected place"})).toBeVisible();
    const link=await db.collection("place_connections").findOne({session_id:sid});
    expect(link).toMatchObject({a:{place_id:pid,side:"east",offset:6},b:{side:"west",offset:6},width:3});
    const target=link!.b.place_id;
    expect(await db.collection("place_scenes").findOne({session_id:sid,place_id:pid})).toEqual(sourceBefore);
    await page.getByRole("combobox",{name:"Connected place"}).selectOption(target);await ready();
    await expect(page.getByRole("textbox",{name:"Place name",exact:true})).toHaveValue("Canal yard");
    await page.getByRole("combobox",{name:"Component type"}).selectOption("bench");await page.getByRole("button",{name:"Add object",exact:true}).click();
    await page.getByLabel("Material color",{exact:true}).fill("#c83848");await apply(2);
    await page.getByRole("combobox",{name:"Connected place"}).selectOption(pid);await ready();
    await page.getByRole("button",{name:"Walk",exact:true}).click();await ready();
    await expect(viewport).toHaveAttribute("data-place-id",pid);
    await expect(viewport).toHaveAttribute("data-loaded-places","2");
    await expect(page.getByRole("textbox",{name:"Place name",exact:true})).toHaveCount(0);
    const canvas=await viewport.locator("canvas").elementHandle();
    const samples=page.evaluate(async()=>{
      const values:number[]=[],end=performance.now()+3000;
      while(performance.now()<end){await new Promise(requestAnimationFrame);const p=document.querySelector('[data-testid="place-viewport"]')?.getAttribute("data-camera");if(p)values.push(Number(p.split(",")[0]));}
      return values;
    });
    await page.keyboard.down("d");await expect.poll(async()=>(await camera())[0]).toBeGreaterThan(14);await page.keyboard.up("d");
    await expect(viewport).toHaveAttribute("data-place-id",target);
    await expect(page.getByRole("combobox",{name:"Connected place"})).toHaveValue(target);
    expect(await canvas!.evaluate(el=>el.isConnected)).toBe(true);
    const positions=await samples;expect(Math.max(...positions.slice(1).map((p,i)=>Math.abs(p-positions[i]!)))).toBeLessThan(0.2);
    // Look at the authored target bench using ordinary turn input, not a camera teleport.
    await page.keyboard.down("ArrowRight");
    try{await expect.poll(async()=>Number(await viewport.getAttribute("data-yaw")),{intervals:[30]}).toBeLessThan(-1.55);}finally{await page.keyboard.up("ArrowRight");}
    await viewport.scrollIntoViewIfNeeded();
    const redPixels=await viewport.locator("canvas").evaluate(el=>{
      const c=document.createElement("canvas");c.width=c.height=128;const ctx=c.getContext("2d")!;ctx.drawImage(el as HTMLCanvasElement,0,0,128,128);
      const pixels=ctx.getImageData(0,0,128,128).data;let red=0;
      for(let i=0;i<pixels.length;i+=4)if(pixels[i]!>pixels[i+1]!*1.5&&pixels[i]!>pixels[i+2]!*1.25&&pixels[i]!>60)red++;
      return red;
    });
    expect(redPixels).toBeGreaterThan(30);
    await page.screenshot({path:`test-results/connected-places-${width}-crossing.png`});
    await page.keyboard.down("ArrowLeft");
    try{await expect.poll(async()=>Number(await viewport.getAttribute("data-yaw")),{intervals:[30]}).toBeGreaterThan(-0.02);}finally{await page.keyboard.up("ArrowLeft");}
    await page.keyboard.down("a");await expect.poll(async()=>(await camera())[0]).toBeLessThan(11);await page.keyboard.up("a");
    await expect(viewport).toHaveAttribute("data-place-id",pid);
    expect(await canvas!.evaluate(el=>el.isConnected)).toBe(true);
    await page.keyboard.down("d");try{await expect.poll(async()=>(await camera())[0]).toBeGreaterThan(13);}finally{await page.keyboard.up("d");}
    await expect.poll(async()=>(await db.collection("creator_worlds").findOne({_id:sid as never}))?.walk_position?.pose?.place_id).toBe(target);
    await expect(page.getByRole("status").filter({hasText:/^Position saved$/})).toBeVisible();
    const crossedPosition=await camera();await page.reload();await ready();
    await expect(viewport).toHaveAttribute("data-place-id",target);await expect(viewport).toHaveAttribute("data-pose-restore","restored");
    for(let i=0;i<3;i++)expect((await camera())[i]).toBeCloseTo(crossedPosition[i]!,1);
    if(width===1280){
      const beforeNavigation=page.url();
      await page.route("**/api/world/scene-context?*",r=>r.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Temporary place load failure"})}),{times:1});
      await page.getByRole("button",{name:"Edit this place",exact:true}).click();
      await expect(page.getByRole("alert").filter({hasText:"Temporary place load failure"})).toBeVisible();
      expect(page.url()).toBe(beforeNavigation);
      await page.getByRole("button",{name:"Edit this place",exact:true}).click();
    }else await page.getByRole("button",{name:"Plan",exact:true}).click();
    await ready();
    await expect(page.getByRole("textbox",{name:"Place name",exact:true})).toHaveValue("Canal yard");
    await page.getByRole("combobox",{name:"Connected place"}).selectOption(pid);await ready();
    await page.getByRole("button",{name:"Plan",exact:true}).click();await ready();
    await page.getByRole("spinbutton",{name:"Place width",exact:true}).fill("14");
    await page.getByRole("button",{name:"Preview",exact:true}).click();await expect(page.getByRole("alert").filter({hasText:"align"})).toBeVisible();
    // Rejecting a resize leaves both canonical frames and the link unchanged.
    expect((await db.collection("place_scenes").findOne({session_id:sid,place_id:pid}))!.definition.width).toBe(12);
    page.once("dialog",d=>d.accept());await page.reload();await ready();
    const network=await page.request.get(`/api/world/${sid}/places/${pid}/connections`);expect(network.status()).toBe(200);expect((await network.json()).network.chunks).toHaveLength(2);
    // Fault injection only: a remote chunk references an unavailable saved mesh.
    // No fixture is persisted and this does not count as generated-asset acceptance.
    const broken=await network.json(),remote=broken.network.chunks.find((c:{scene:{place_id:string}})=>c.scene.place_id===target);
    remote.scene.definition.objects.push({...remote.scene.definition.objects[0],id:"missing_mesh",kind:"mesh",asset_id:"missing_asset",x:9,z:9});
    await page.route(`**/api/world/${sid}/places/${pid}/connections`,r=>r.fulfill({json:broken}),{times:1});
    await page.route(`**/api/world/${sid}/meshes/missing_asset`,r=>r.fulfill({status:503}),{times:1});
    await page.reload();await ready();
    await page.getByRole("button",{name:"Walk",exact:true}).click();
    await expect(page.getByRole("alert").filter({hasText:"Saved mesh could not be loaded"})).toBeVisible();
    await expect(viewport).not.toHaveAttribute("data-ready","true");
    await expect(viewport).not.toHaveAttribute("data-loaded-places");
    expect((await db.collection("place_scenes").findOne({session_id:sid,place_id:target}))!.definition.objects).toHaveLength(1);
    await page.reload();await ready();
    const bundle=await page.request.get(`/api/export/session/${sid}`);expect(bundle.status()).toBe(200);
    const zip=await JSZip.loadAsync(await bundle.body());expect(JSON.parse(await zip.file("place-connections.json")!.async("string"))).toHaveLength(1);
    const forkResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/sessions/${sid}/fork`&&r.request().method()==="POST");await page.getByRole("button",{name:"Fork world",exact:true}).click();
    const fork=await(await forkResponse).json();created.push(fork.session_id);await ready();
    const forkNetwork=await page.request.get(`/api/world/${fork.session_id}/places/${pid}/connections`);expect(forkNetwork.status()).toBe(200);expect((await forkNetwork.json()).network.connections[0].id).toBe(link!.id);
    const other=await browser.newContext({baseURL});try{expect((await other.request.get(`/api/world/${sid}/places/${pid}/connections`)).status()).toBe(403);}finally{await other.close();}
    expect(errors).toEqual([]);expect(paid).toEqual([]);expect(await db.collection("nodes").countDocuments({session_id:{$in:created}})).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{
    for(const sid of [...new Set(created)]){
      for(const name of ["place_scenes","place_scene_versions","place_connections","world_edit_proposals"])await db.collection(name).deleteMany({session_id:sid});
      for(const name of ["world_map","world_state","session_owners","creator_worlds"])await db.collection(name).deleteOne({_id:sid as never});
    }
    await client.close();
  }
});

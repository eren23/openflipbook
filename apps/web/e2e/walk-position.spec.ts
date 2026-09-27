import {expect,test} from "@playwright/test";
import {MongoClient} from "mongodb";

test.skip(process.env.E2E_WALK_POSITION!=="1","Real owned-world walking persistence; no model calls");
for(const width of [1280,390])test(`restore an upper-floor position and recover after removing the floor at ${width}`,async({page,browser,baseURL})=>{
  if(!baseURL||!["localhost","127.0.0.1"].includes(new URL(baseURL).hostname))throw new Error("Local server required");
  process.loadEnvFile(".env.local");const client=new MongoClient(process.env.MONGODB_URI!);await client.connect();const db=client.db(process.env.MONGODB_DB);
  let sid="";const errors:string[]=[],paid:string[]=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("response",async r=>{if(r.ok()&&r.request().method()==="POST"&&new URL(r.url()).pathname==="/api/creator/worlds")sid=(await r.json()).session_id;});
  await page.route(/\/api\/(generate-page|sketches\/[^/]+\/generate|world\/[^/]+\/meshes)/,r=>{if(r.request().method()!=="GET"){paid.push(r.request().url());return r.abort();}return r.continue();});
  const viewport=page.getByTestId("place-viewport"),ready=()=>expect(viewport).toHaveAttribute("data-ready","true");
  const camera=async()=>(await viewport.getAttribute("data-camera"))!.split(",").map(Number);
  const saved=async()=>(await db.collection("creator_worlds").findOne({_id:sid as never}))?.walk_position;
  const apply=async(revision:number)=>{await page.getByRole("button",{name:"Preview",exact:true}).click();await page.getByRole("button",{name:"Apply to world",exact:true}).click();await expect(page.getByRole("status").filter({hasText:`Revision ${revision}`})).toHaveText(`Revision ${revision} · Saved`);await ready();};
  try{
    await page.setViewportSize({width,height:width===390?844:900});await page.goto("/sketch/world");await ready();
    await page.getByLabel("Place name",{exact:true}).fill("Workshop loft");
    await page.getByLabel("Place width",{exact:true}).fill("20");await page.getByLabel("Place depth",{exact:true}).fill("20");
    await page.getByText("Entrance",{exact:true}).click();await page.getByLabel("Entrance x",{exact:true}).fill("10");await page.getByLabel("Entrance z",{exact:true}).fill("16");
    await page.getByRole("combobox",{name:"Component type"}).selectOption("building");await page.getByRole("button",{name:"Add object",exact:true}).click();
    await page.getByRole("combobox",{name:"Building floors"}).selectOption("2");await page.getByRole("checkbox",{name:"Confirm authored dimensions"}).check();await apply(1);
    sid=new URL(page.url()).searchParams.get("world")!;
    const pid=new URL(page.url()).searchParams.get("place")!;
    await page.getByText("Add adjoining area",{exact:true}).click();await page.getByRole("textbox",{name:"Adjoining area name"}).fill("Workshop yard");
    await page.getByRole("button",{name:"Preview adjoining area",exact:true}).click();await page.getByRole("button",{name:"Apply adjoining area",exact:true}).click();
    await expect(page.getByRole("combobox",{name:"Connected place"})).toBeVisible();await ready();
    await page.getByRole("button",{name:"Walk",exact:true}).click();await ready();await viewport.scrollIntoViewIfNeeded();
    await page.keyboard.down("w");try{await expect.poll(async()=>(await camera())[2],{intervals:[30]}).toBeLessThan(12.4);}finally{await page.keyboard.up("w");}
    await page.keyboard.down("a");try{await expect.poll(async()=>(await camera())[0],{intervals:[30]}).toBeLessThan(7.15);}finally{await page.keyboard.up("a");}
    await page.waitForTimeout(150);
    for(let i=0;i<40;i++){const x=(await camera())[0]!;if(Math.abs(x-7.05)<0.14)break;await page.keyboard.press(x>7.05?"a":"d",{delay:5});await page.waitForTimeout(150);}
    expect((await camera())[0]).toBeGreaterThan(6.9);expect((await camera())[0]).toBeLessThan(7.2);
    await page.keyboard.down("w");try{await expect.poll(async()=>(await camera())[1]).toBeGreaterThan(4.7);await expect.poll(async()=>(await camera())[2],{intervals:[30]}).toBeLessThan(6.3);}finally{await page.keyboard.up("w");}
    await page.keyboard.down("ArrowRight");try{await expect.poll(async()=>Number(await viewport.getAttribute("data-yaw")),{intervals:[30]}).toBeLessThan(-2.32);}finally{await page.keyboard.up("ArrowRight");}
    await expect.poll(async()=>(await saved())?.pose?.position.y??0).toBeGreaterThan(4);
    await expect.poll(async()=>(await saved())?.pose?.yaw??0).toBeLessThan(-2.3);
    await expect(page.getByRole("status").filter({hasText:/^Position saved$/})).toBeVisible();
    const before=await camera();await page.reload();await ready();
    await expect(viewport).toHaveAttribute("data-mode","walk");await expect(viewport).toHaveAttribute("data-pose-restore","restored");
    for(let i=0;i<3;i++)expect((await camera())[i]).toBeCloseTo(before[i]!,1);
    expect(Number(await viewport.getAttribute("data-yaw"))).toBeLessThan(-2.3);
    const range=await viewport.locator("canvas").evaluate(el=>{const c=document.createElement("canvas");c.width=c.height=64;const ctx=c.getContext("2d")!;ctx.drawImage(el as HTMLCanvasElement,0,0,64,64);const pixels=[...ctx.getImageData(0,0,64,64).data].filter((_,i)=>i%4!==3);return Math.max(...pixels)-Math.min(...pixels);});
    expect(range).toBeGreaterThan(30);
    await page.screenshot({path:`test-results/walk-position-${width}-upper-restored.png`});
    // A harmless appearance edit retains the same safe upper-floor pose.
    await page.getByRole("button",{name:"Plan",exact:true}).click();await ready();
    await page.getByRole("button",{name:"Building building",exact:true}).click();await page.getByLabel("Material color",{exact:true}).fill("#8cb3a0");await apply(2);
    await page.getByRole("button",{name:"Walk",exact:true}).click();await ready();await expect(viewport).toHaveAttribute("data-pose-restore","revalidated");
    expect((await camera())[1]).toBeGreaterThan(4.7);
    await page.getByRole("button",{name:"Plan",exact:true}).click();await ready();await page.getByRole("button",{name:"Building building",exact:true}).click();
    await page.getByRole("combobox",{name:"Building floors"}).selectOption("1");await apply(3);
    await page.getByRole("button",{name:"Walk",exact:true}).click();await ready();await expect(viewport).toHaveAttribute("data-pose-restore","recovered");
    await expect(page.getByRole("status").filter({hasText:"Returned to the entrance"})).toBeVisible();
    const notice=await page.getByRole("status").filter({hasText:"Returned to the entrance"}).boundingBox(),canvasBox=await viewport.boundingBox(),controls=await page.getByRole("button",{name:"Walk forward",exact:true}).boundingBox();
    expect(notice!.y+notice!.height).toBeLessThanOrEqual(canvasBox!.y+1);expect(notice!.y+notice!.height).toBeLessThan(controls!.y);
    const badge=await page.getByRole("status").filter({hasText:/^Workshop loft$/}).boundingBox();expect(badge!.y).toBeGreaterThanOrEqual(canvasBox!.y);
    expect((await camera())[0]).toBeCloseTo(10,1);expect((await camera())[1]).toBeCloseTo(1.6,1);expect((await camera())[2]).toBeCloseTo(16,1);
    await page.screenshot({path:`test-results/walk-position-${width}-recovered.png`});
    await expect.poll(async()=>(await saved())?.pose?.scene_revision??0).toBe(3);
    await expect(page.getByRole("status").filter({hasText:/^Position saved$/})).toBeVisible();
    await page.getByRole("button",{name:"Plan",exact:true}).click();await ready();
    const current=await saved(),url=`/api/creator/worlds/${sid}/walk`;
    const stale=await page.request.post(url,{data:{request_id:crypto.randomUUID(),base_revision:current.revision,pose:{...current.pose,scene_revision:1}}});expect(stale.status()).toBe(409);
    const a={request_id:crypto.randomUUID(),base_revision:current.revision,pose:current.pose},b={...a,request_id:crypto.randomUUID()};
    const responses=await Promise.all([page.request.post(url,{data:a}),page.request.post(url,{data:b})]);expect(responses.map(r=>r.status()).sort()).toEqual([200,409]);
    const winner=responses[0]!.status()===200?a:b;expect((await page.request.post(url,{data:winner})).status()).toBe(200);
    const foreign=await browser.newContext({baseURL});try{expect((await foreign.request.get(url)).status()).toBe(403);expect((await foreign.request.post(url,{data:winner})).status()).toBe(403);}finally{await foreign.close();}
    expect((await db.collection("place_scenes").findOne({session_id:sid,place_id:pid}))!.revision).toBe(3);
    expect(await db.collection("nodes").countDocuments({session_id:sid})).toBe(0);expect(paid).toEqual([]);expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{
    await page.goto("about:blank");
    if(sid){for(const name of ["place_scenes","place_scene_versions","place_connections","world_edit_proposals"])await db.collection(name).deleteMany({session_id:sid});for(const name of ["world_map","world_state","session_owners","creator_worlds"])await db.collection(name).deleteOne({_id:sid as never});}
    await client.close();
  }
});

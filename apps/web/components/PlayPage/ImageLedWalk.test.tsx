import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageLedWalkQuote, ImageLedWalkWire } from "@/lib/image-led-walk";
import { ImageLedWalk } from "./ImageLedWalk";

vi.mock("@/components/sketch/saved-walk-player",()=>({default:({src}:{src:string})=><div data-testid="saved-player" data-src={src}/>}));
const sha = "a".repeat(64), binding="b".repeat(64), routeHash="c".repeat(64);
const image={sha256:sha,bytes:100,width:1000,height:600,content_type:"image/png" as const};
const mapFrame={bounds:{x:0,y:0,w:95.2,h:48},parent_id:null};
const points=[{x:.2,y:.8},{x:.5,y:.4}];
const source={node_id:"node1",map_frame:mapFrame,image,image_url:"/source.png",landmarks:[
  {id:"book",entity_id:null,label:"Bookshop",visual:"Original projecting book bay",crop_available:true},
  {id:"glass",entity_id:null,label:"Glasshouse",visual:"Faceted planted glass",crop_available:true},
  {id:"town",entity_id:null,label:"Proxy place",visual:"",crop_available:false}
],seeds:[{view_id:"view-B07",asset_id:"reviewed-B07",sha256:"d".repeat(64),label:"Reviewed B07",image_url:"/b07.png"}]};
function makeWalk():ImageLedWalkWire{return {
  id:"walk1",session_id:"session1",profile:"image-led-v1",created_at:"2026-10-05T00:00:00Z",updated_at:"2026-10-05T00:00:00Z",request_sha256:"e".repeat(64),status:"draft",revision:1,
  source:{node_id:"node1",map_frame:mapFrame,image,image_url:"/source.png",source_projection:"illustrated_oblique_or_unknown",binding_sha256:binding},
  route:{frame:"original-image-normalized",points,map_sha256:sha,sha256:routeHash},prompt:"Same buildings",landmarks:[],
  frames:points.map((_,index)=>({index,status:"empty",review:{identity:"pending",route:"pending",spatial:"unmeasured"}})),
  legs:[{index:0,from:0,to:1,status:"empty",review:{temporal:"pending"}}]
};}
function q(kind:"still"|"video"="still",index=0):ImageLedWalkQuote{return {version:1,profile:"image-led-v1",kind,index,model:"explicit-model",parameters:{},reservation:kind==="still"?.3:.4,retry_allowance:0,source_sha256:sha,binding_sha256:binding,route_sha256:routeHash,inputs_sha256:"f".repeat(64),quote_sha256:"1".repeat(64),spatial_validation:"unmeasured"};}
const response=(data:unknown,ok=true)=>({ok,status:ok?200:409,json:async()=>data}) as Response;
const props={sessionId:"session1",nodeId:"node1",mapFrame:{bounds:{x:0,y:0,w:100,h:60},parent_id:null},points,sourceImageUrl:"/fallback.png",open:true,onClose:vi.fn()};
const key="ofb:image-led:session1:node1";
beforeEach(()=>{localStorage.clear();});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
async function restore(walk:ImageLedWalkWire,extra?:(url:string,init?:RequestInit)=>Promise<Response>|Response){
  localStorage.setItem(`${key}:selected`,walk.id);
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>extra&&init?extra(url,init):response(url.includes("?kind=")?{walk,quote:q(url.includes("kind=video")?"video":"still",Number(new URL(url,"http://localhost").searchParams.get("index")))}:{walks:[walk],source}));
  vi.stubGlobal("fetch",fetch);render(<ImageLedWalk {...props}/>);await screen.findByRole("button",{name:/View 1/});return fetch;
}
describe("ImageLedWalk",()=>{
  it("opens above the map's stacking layer so fixed navigation cannot obscure review controls",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>response({walks:[],source})));
    render(<div data-testid="map-layer" style={{position:"relative",zIndex:20}}><ImageLedWalk {...props}/></div>);
    await screen.findByLabelText("Bookshop");
    const dialog=screen.getByRole("dialog",{name:"Image-led illustrated walk"});
    expect(screen.getByTestId("map-layer").contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
  it("saves normalized route and only actual source references, with an explicitly chosen current reviewed seed",async()=>{
    const walk=makeWalk();const writes:Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>{if(!init)return response({walks:[],source});const body=JSON.parse(String(init.body));writes.push(body);expect(JSON.parse(localStorage.getItem(`${key}:pending`)!)).toEqual({kind:"create",body});return response({walk:{...walk,id:body.id}});}));
    render(<ImageLedWalk {...props}/>);await screen.findByLabelText("Bookshop");
    expect((screen.getByLabelText("Proxy place") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Starting painting") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Starting painting"),{target:{value:"reviewed-B07"}});
    expect(screen.getByAltText("Chosen reviewed starting painting").getAttribute("src")).toBe("/b07.png");
    await act(async()=>fireEvent.click(screen.getByText("Save image-led route — free")));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({source_node_id:"node1",map_frame:mapFrame,points,landmark_ids:["book","glass"],seed:{view_id:"view-B07",asset_id:"reviewed-B07",sha256:"d".repeat(64)}});
    expect(Object.keys(writes[0] ?? {}).some(key=>["control_data_url","observer","depth","scene_id"].includes(key))).toBe(false);
    expect(localStorage.getItem(`${key}:pending`)).toBeNull();
  });

  it("gets a free quote before any paid request, then schedules once with exact quote and UUID",async()=>{
    const walk=makeWalk();const writes:Record<string,unknown>[]=[];
    const fetch=await restore(walk,async(_url,init)=>{const body=JSON.parse(String(init?.body));writes.push(body);const saved=makeWalk();saved.frames[0]={...saved.frames[0]!,status:"queued",job_id:body.id};return response({walk:saved});});
    expect(fetch.mock.calls.every(([,init])=>!init)).toBe(true);
    fireEvent.click(screen.getByText("Quote this painting — free"));await screen.findByText("Generate painting — up to $0.30");
    expect(writes).toHaveLength(0);
    await act(async()=>fireEvent.click(screen.getByText("Generate painting — up to $0.30")));
    expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({action:"schedule",kind:"still",index:0,quote:q(),confirmed:true});
    expect(typeof writes[0]!.id).toBe("string");expect(localStorage.getItem(`${key}:pending`)).toBeNull();
  });

  it("recovers a lost pre-claim acknowledgement after refresh using the identical retained request",async()=>{
    const walk=makeWalk();const posts:string[]=[];let failed=true;let saved=walk;
    localStorage.setItem(`${key}:selected`,walk.id);
    vi.stubGlobal("fetch",vi.fn(async(url:string,init?:RequestInit)=>{
      if(init){posts.push(String(init.body));if(failed){failed=false;throw new Error("network interrupted before claim");}const body=JSON.parse(String(init.body));saved={...walk,frames:[{...walk.frames[0]!,status:"queued",job_id:body.id},walk.frames[1]!]};return response({walk:saved});}
      return response(url.includes("?kind=")?{walk,quote:q()}:{walks:[saved],source});
    }));
    const rendered=render(<ImageLedWalk {...props}/>);await screen.findByText("Quote this painting — free");
    fireEvent.click(screen.getByText("Quote this painting — free"));await screen.findByText("Generate painting — up to $0.30");
    await act(async()=>fireEvent.click(screen.getByText("Generate painting — up to $0.30")));
    const retained=localStorage.getItem(`${key}:pending`);expect(retained).toBeTruthy();
    fireEvent.click(screen.getByText("Check saved progress — free"));await act(async()=>{});expect(posts).toHaveLength(1);
    rendered.unmount();render(<ImageLedWalk {...props}/>);await screen.findByText("Recover this same request");
    await act(async()=>fireEvent.click(screen.getByText("Recover this same request")));
    expect(posts).toHaveLength(2);expect(posts[1]).toBe(posts[0]);expect(localStorage.getItem(`${key}:pending`)).toBeNull();
  });

  it("does not clear a paid pending receipt for a different job in the same slot",async()=>{
    const walk=makeWalk();walk.frames[0]={...walk.frames[0]!,job_id:"other-job",status:"queued"};
    localStorage.setItem(`${key}:pending`,JSON.stringify({kind:"schedule",walk_id:walk.id,body:{action:"schedule",id:"retained-job",kind:"still",index:0,quote:q(),confirmed:true}}));
    await restore(walk);
    expect(screen.getByText("Recover this same request")).toBeTruthy();
    expect(localStorage.getItem(`${key}:pending`)).toContain("retained-job");
  });

  it("requires decoded painting and both identity/route checks; review pins exact image SHA",async()=>{
    const walk=makeWalk();walk.frames[0]={...walk.frames[0]!,status:"ready",image,image_url:"/generated.png"};
    const posts:Record<string,unknown>[]=[];
    await restore(walk,async(_url,init)=>{posts.push(JSON.parse(String(init?.body)));return response({walk});});
    const approval=screen.getByText("Approve identity and route");expect((approval as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("These are the same buildings and façade details as the source."));
    fireEvent.click(screen.getByLabelText("Position, facing direction and neighbouring buildings fit this drawn route."));
    expect((approval as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(screen.getByAltText(/Generated street painting/));
    await act(async()=>fireEvent.click(approval));
    expect(posts).toEqual([{action:"review",kind:"still",index:0,sha256:sha,identity:"approved",route:"approved"}]);
  });

  it("blocks video quoting when an endpoint has pending source identity or route review",async()=>{
    const walk=makeWalk();walk.frames=walk.frames.map(f=>({...f,status:"ready",image,image_url:"/still.png",review:{...f.review,identity:"approved",route:"approved",sha256:sha}}));
    walk.frames[1]!.review.route="pending";
    const fetch=await restore(walk);fireEvent.click(screen.getByText("Walking clips"));
    expect((screen.getByText("Quote this walking clip — free") as HTMLButtonElement).disabled).toBe(true);
    expect(fetch.mock.calls.some(([url])=>url.includes("kind=video"))).toBe(false);
  });

  it("discards a source-mismatched quote and never schedules it",async()=>{
    const walk=makeWalk();localStorage.setItem(`${key}:selected`,walk.id);
    const fetch=vi.fn(async(url:string)=>response(url.includes("?kind=")?{walk,quote:{...q(),source_sha256:"wrong"}}:{walks:[walk],source}));vi.stubGlobal("fetch",fetch);
    render(<ImageLedWalk {...props}/>);await screen.findByText("Quote this painting — free");fireEvent.click(screen.getByText("Quote this painting — free"));
    await screen.findByText("Quote does not match this source and route.");expect(screen.queryByText(/Generate painting/)).toBeNull();
  });

  it("drops a late quote after the user changes checkpoints",async()=>{
    const walk=makeWalk();let answer:(r:Response)=>void=()=>{};localStorage.setItem(`${key}:selected`,walk.id);
    vi.stubGlobal("fetch",vi.fn((url:string)=>url.includes("?kind=")?new Promise<Response>(resolve=>{answer=resolve;}):Promise.resolve(response({walks:[walk],source}))));
    render(<ImageLedWalk {...props}/>);await screen.findByText("Quote this painting — free");fireEvent.click(screen.getByText("Quote this painting — free"));
    fireEvent.click(screen.getByRole("button",{name:/View 2/}));await act(async()=>answer(response({walk,quote:q()})));
    expect(screen.queryByText(/Generate painting/)).toBeNull();
    expect(screen.getByRole("button",{name:/View 2/}).getAttribute("aria-pressed")).toBe("true");
  });

  it("lets the owner correct a rejected free create only after GET confirms no stored receipt",async()=>{
    const fetch=vi.fn(async(_url:string,init?:RequestInit)=>init?response({error:"Source crop is invalid"},false):response({walks:[],source}));vi.stubGlobal("fetch",fetch);
    render(<ImageLedWalk {...props}/>);await screen.findByLabelText("Bookshop");await act(async()=>fireEvent.click(screen.getByText("Save image-led route — free")));
    expect(screen.getByRole("alert").textContent).toContain("Source crop is invalid");expect(localStorage.getItem(`${key}:pending`)).toBeNull();
    expect((screen.getByText("Save image-led route — free") as HTMLButtonElement).disabled).toBe(false);
  });

  it("cannot post when the durable request receipt cannot be stored",async()=>{
    const fetch=vi.fn(async()=>response({walks:[],source}));vi.stubGlobal("fetch",fetch);render(<ImageLedWalk {...props}/>);await screen.findByLabelText("Bookshop");
    vi.spyOn(localStorage,"setItem").mockImplementation(()=>{throw new Error("quota exceeded");});
    await act(async()=>fireEvent.click(screen.getByText("Save image-led route — free")));
    expect(screen.getByRole("alert").textContent).toContain("No step was submitted");expect(fetch.mock.calls).toHaveLength(1);
  });

  it("requires three genuinely decoded intermediate samples before temporal approval",async()=>{
    const walk=makeWalk();walk.legs[0]={...walk.legs[0]!,status:"ready",video:{sha256:sha,bytes:100,content_type:"video/mp4"},video_url:"/actual.mp4",media:{width:688,height:384,duration:5,audio_streams:0,source_audio_streams:1,derivative:"silent_streamcopy_v1"}};
    const posts:Record<string,unknown>[]=[];await restore(walk,async(_url,init)=>{posts.push(JSON.parse(String(init?.body)));return response({walk});});
    fireEvent.click(screen.getByText("Walking clips"));const video=document.querySelector("video")!;
    Object.defineProperty(video,"duration",{value:5,configurable:true});Object.defineProperty(video,"readyState",{value:2,configurable:true});vi.spyOn(video,"pause").mockImplementation(()=>{});
    fireEvent.click(screen.getByLabelText("I watched the motion and checked intermediate frames for changing architecture."));
    expect((screen.getByText("Approve temporal continuity") as HTMLButtonElement).disabled).toBe(true);
    for(const name of ["Inspect early frame","Inspect middle frame","Inspect late frame"]){fireEvent.click(screen.getByText(name));fireEvent.seeked(video);}
    await act(async()=>fireEvent.click(screen.getByText("Approve temporal continuity")));
    expect(posts).toEqual([{action:"review",kind:"video",index:0,sha256:sha,temporal:"approved"}]);
  });
});
it("starts an explicit free retry at the rejected position while keeping the reviewed prefix and requiring a fresh quote", async () => {
  const walk = makeWalk(); walk.frames[0] = { index: 0, status: "ready", image, image_url: "/approved.png", review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256: sha, reviewed_at: new Date(0).toISOString() } };
  walk.frames[1] = { index: 1, status: "ready", image, image_url: "/rejected.png", review: { identity: "rejected", route: "rejected", spatial: "unmeasured", sha256: sha, reviewed_at: new Date(0).toISOString() } };
  const writes: Record<string, unknown>[] = [];
  await restore(walk, async (_url, init) => { const body = JSON.parse(String(init?.body)); writes.push(body); expect(JSON.parse(localStorage.getItem(`${key}:pending`)!)).toMatchObject({ kind: "fork", walk_id: walk.id, prefix_sha256: [sha], body }); return response({ walk: { ...makeWalk(), id: body.id, frames: [walk.frames[0], makeWalk().frames[1]] } }); });
  fireEvent.click(screen.getByRole("button", { name: /View 2/ }));
  await act(async () => fireEvent.click(screen.getByText("New attempt from this position — free")));
  expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ action: "fork", index: 1, revision: 1 });
  expect(writes[0]).not.toHaveProperty("quote"); expect(writes[0]).not.toHaveProperty("confirmed"); expect(localStorage.getItem(`${key}:pending`)).toBeNull();
  expect(screen.getByRole("button", { name: /View 2/ }).getAttribute("aria-pressed")).toBe("true"); expect(screen.queryByText(/Generate painting/)).toBeNull();
  expect(screen.getByText("Quote this painting — free")).toBeTruthy(); expect(walk.frames[1]!.review.identity).toBe("rejected");
});
it("disables a later retry when the preceding view has not been approved", async () => {
  const walk = makeWalk(); walk.frames[1] = { ...walk.frames[1]!, status: "ready", image, image_url: "/rejected.png", review: { identity: "rejected", route: "rejected", spatial: "unmeasured", sha256: sha } };
  const fetch = await restore(walk); fireEvent.click(screen.getByRole("button", { name: /View 2/ }));
  expect((screen.getByText("New attempt from this position — free") as HTMLButtonElement).disabled).toBe(true); expect(fetch.mock.calls.every(([, init]) => !init)).toBe(true);
});
it("recovers a lost fork acknowledgement by GET without retrying the POST or generating", async () => {
  const walk = makeWalk(); walk.frames[0] = { ...walk.frames[0]!, status: "ready", image, image_url: "/approved.png", review: { identity: "approved", route: "approved", spatial: "unmeasured", sha256: sha } };
  const body = { action: "fork", id: "fork1", index: 1, revision: 1 };
  localStorage.setItem(`${key}:pending`, JSON.stringify({ kind: "fork", walk_id: walk.id, source_sha256: sha, route_sha256: routeHash, prefix_sha256: [sha], body }));
  const forked = { ...walk, id: "fork1" }; const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ walks: [walk, forked], source })); vi.stubGlobal("fetch", fetch);
  render(<ImageLedWalk {...props}/>); await screen.findByRole("button", { name: /View 2/ });
  expect(screen.getByRole("button", { name: /View 2/ }).getAttribute("aria-pressed")).toBe("true"); expect(localStorage.getItem(`${key}:pending`)).toBeNull();
  expect(localStorage.getItem(`${key}:selected`)).toBe("fork1"); expect(fetch.mock.calls.every(([, init]) => !init)).toBe(true); expect(screen.queryByText(/Generate painting/)).toBeNull();
});

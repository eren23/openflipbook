import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import type { PlaceNetwork, WorldEditProposal } from "@openflipbook/config";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";

const viewport=vi.hoisted(()=>({props:{} as {route?:unknown;getWalkPose?:()=>unknown;interactionPaused?:boolean;onWalkPose?:unknown}}));
vi.mock("next/dynamic",()=>({default:()=>function Viewport(props:{selected:string|null;mode:string;floorId?:string;focusKey?:number;route?:unknown;getWalkPose?:()=>unknown;interactionPaused?:boolean}){
  const {selected,mode,floorId,focusKey}=props;viewport.props=props;
  return <div data-testid="viewport" data-selected={selected??""} data-mode={mode} data-floor={floorId??""} data-focus={focusKey}/>;
}}));
vi.mock("@/hooks/useWalkPosition",()=>({useWalkPosition:()=>({ready:true,getPose:()=>null,record:()=>{},flush:()=>{},state:{status:"idle"},retry:()=>{}})}));
const walkVideo=vi.hoisted(()=>({props:null as {route?:unknown;placeId?:string}|null}));
vi.mock("./path-video",()=>({default:()=>null,WalkVideo:(props:{route?:unknown;placeId:string})=>{walkVideo.props=props;return <section aria-label="Saved walk videos"/>;}}));
vi.mock("./mesh-generator",()=>({default:()=>null}));
vi.mock("./place-builder",()=>({default:()=>null}));
vi.mock("./world-publication",()=>({default:({sessionId}:{sessionId:string})=><section aria-label="World publication" data-world={sessionId}/> }));
const textEdits=vi.hoisted(()=>({props:null as {sessionId:string;placeId:string;baseRevision:number;selectedObjectId:string|null;disabled:boolean;onProposal:(p:WorldEditProposal)=>void;onPendingChange:(v:boolean)=>void}|null}));
vi.mock("./place-scene-edits",()=>({default:(props:NonNullable<typeof textEdits.props>)=>{
  textEdits.props=props;
  return <section aria-label="Text scene edits"><button onClick={()=>props.onPendingChange(true)}>Freeze saved edit request</button><button onClick={()=>props.onPendingChange(false)}>Recover saved edit request</button></section>;
}}));
vi.mock("./adjacent-place-editor",()=>({default:()=>null}));
vi.mock("./building-inspector",()=>({default:()=>null}));
vi.mock("./material-editor",()=>({default:()=>null,GroundMaterialEditor:()=>null}));
vi.mock("./mesh-orientation-editor",()=>({default:()=>null}));
vi.mock("./place-view-library",()=>({default:function Library({onSelectedViewChange,onSelectObject,onComposeSelection}:{onSelectedViewChange:(id:string|null)=>void;onSelectObject:(id:string)=>void;onComposeSelection?:()=>void}){
  useEffect(()=>onSelectedViewChange(new URLSearchParams(location.search).get("camera")),[onSelectedViewChange]);
  return <><button onClick={()=>onSelectObject("bench")}>Select furnishing in illustration</button>{onComposeSelection&&<button onClick={onComposeSelection}>Compose selected object</button>}</>;
}}));
import WorldEditor from "./world-editor";

const inn={...newComponent("building",8,10),id:"inn",label:"Inn"},shop={...newComponent("building",25,10),id:"shop",label:"Shop"};
const floor=inn.structure!.floors[0]!.id,otherFloor=shop.structure!.floors[0]!.id;
const definition={...emptyPlaceScene(),version:2 as const,objects:[inn,shop,{...newComponent("bench",0,0),id:"bench",label:"Seat",placement:{building_id:"inn",floor_id:floor}}]};
const scene={id:"scene",session_id:"world",place_id:"place",revision:1,source_node_id:"street",source_image_key:"street.png",updated_at:new Date(0).toISOString(),definition};
let connectionError=false;
beforeEach(()=>{
  connectionError=false;walkVideo.props=null;textEdits.props=null;window.history.replaceState(null,"","/sketch/world?world=world&place=place&object=inn&view=orbit&camera=shot");
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:!url.endsWith("connections")||!connectionError,json:async()=>url.endsWith("connections")?connectionError?{error:"Missing connection"}:{network:null}:{session_id:"world",place_id:"place",source_node_id:"street",source_url:"/street.png",initial:definition,scene,history:[scene],drawing:null}})));
});
async function ready(){await screen.findByRole("button",{name:"Inn building"});await waitFor(()=>expect(screen.getAllByTestId("viewport").length).toBeGreaterThan(0));}
const selected=()=>screen.getAllByTestId("viewport")[0]!.getAttribute("data-selected");
it("composes an illustration selection in the real scene without changing its geometry or submitting generation",async()=>{
  render(<WorldEditor/>);await ready();
  const focus=Number(screen.getByTestId("viewport").getAttribute("data-focus"));
  fireEvent.click(screen.getByRole("button",{name:"Illustration"}));
  fireEvent.click(screen.getByRole("button",{name:"Compose selected object"}));
  expect(selected()).toBe("inn");expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("orbit");
  expect(Number(screen.getByTestId("viewport").getAttribute("data-focus"))).toBe(focus+1);
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("restores the selected building and 3D mode without submitting any mutation",async()=>{
  render(<WorldEditor/>);await ready();expect(selected()).toBe("inn");expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("orbit");
  const href=screen.getByRole("link",{name:"Repaint map artwork"}).getAttribute("href")!;
  expect(Object.fromEntries(new URL(href,"http://localhost").searchParams)).toEqual({world:"world",place:"place",object:"inn",view:"orbit",camera:"shot"});
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("opens map artwork and publication for a source-free saved world while retaining selected identities",async()=>{
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith("connections")?{network:null}:{session_id:"world",place_id:"place",source_node_id:null,source_url:null,initial:definition,scene:{...scene,source_node_id:null,source_image_key:null},history:[scene],drawing:null}})));
  render(<WorldEditor/>);await ready();
  const href=screen.getByRole("link",{name:"Create map artwork"}).getAttribute("href")!;
  expect(Object.fromEntries(new URL(href,"http://localhost").searchParams)).toEqual({world:"world",place:"place",object:"inn",view:"orbit",camera:"shot"});
  expect(screen.getByRole("region",{name:"World publication"}).getAttribute("data-world")).toBe("world");
  expect(screen.queryByRole("link",{name:"Explore world"})).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("reviews a saved text edit through the existing proposal flow, preserving furnishing and floor identities",async()=>{
  render(<WorldEditor/>);await ready();fireEvent.click(screen.getByRole("button",{name:"Select furnishing in illustration"}));
  expect(textEdits.props).toMatchObject({sessionId:"world",placeId:"place",baseRevision:1,selectedObjectId:"bench",disabled:false});
  const proposed=structuredClone(definition);proposed.objects[2]!.label="Carved seat";
  fireEvent.click(screen.getByRole("button",{name:"Freeze saved edit request"}));
  // The request recovery control stays interactive while all other editing freezes.
  expect(screen.getByTestId("world-edit-controls").hasAttribute("inert")).toBe(true);
  expect(screen.getByRole("region",{name:"Text scene edits"}).closest("aside")!.hasAttribute("inert")).toBe(false);
  expect((screen.getByRole("button",{name:"Fork world"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Recover saved edit request"}));
  act(()=>textEdits.props!.onProposal({id:"saved-edit",scene_id:"scene",base_revision:1,definition:proposed,changes:["Carved seat renamed"],affected_node_ids:[]}));
  expect(selected()).toBe("bench");expect(screen.getAllByTestId("viewport")).toHaveLength(2);
  expect(screen.getAllByTestId("viewport")[0]!.getAttribute("data-floor")).toBe(floor);
  expect(screen.getByRole("region",{name:"World change preview"})).toBeTruthy();
  expect(textEdits.props!.disabled).toBe(true);expect(proposed.objects[2]!.placement).toEqual(definition.objects[2]!.placement);
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("rejects a saved edit for another scene or revision without replacing the current selection",async()=>{
  render(<WorldEditor/>);await ready();
  act(()=>textEdits.props!.onProposal({id:"stale",scene_id:"other-scene",base_revision:1,definition,changes:[],affected_node_ids:[]}));
  expect(screen.getByRole("alert").textContent).toContain("another scene revision");
  expect(selected()).toBe("inn");expect(screen.queryByRole("region",{name:"World change preview"})).toBeNull();
});
it("keeps exact selection through plan, illustration, split and remount",async()=>{
  const mounted=render(<WorldEditor/>);await ready();
  for(const name of ["Plan","Illustration","Plan + 3D"]){fireEvent.click(screen.getByRole("button",{name}));expect(new URLSearchParams(location.search).get("object")).toBe("inn");}
  fireEvent.click(screen.getByRole("button",{name:"Shop building"}));expect(selected()).toBe("shop");
  mounted.unmount();render(<WorldEditor/>);await ready();expect(selected()).toBe("shop");expect(screen.getAllByTestId("viewport")).toHaveLength(2);
});
it("carries a selected illustration furnishing into its own floor, then leaves that floor for an outdoor building",async()=>{
  render(<WorldEditor/>);await ready();fireEvent.click(screen.getByRole("button",{name:"Select furnishing in illustration"}));
  expect(selected()).toBe("bench");expect((screen.getByRole("combobox",{name:"Editing floor"}) as HTMLSelectElement).value).toBe(floor);
  expect(new URLSearchParams(location.search).get("floor")).toBe(floor);
  fireEvent.click(screen.getByRole("button",{name:"Shop building"}));expect(selected()).toBe("shop");expect((screen.getByRole("combobox",{name:"Editing floor"}) as HTMLSelectElement).value).toBe("");
  expect(new URLSearchParams(location.search).has("floor")).toBe(false);
});
it("changes room context explicitly and returns to the owning building outdoors without moving the furnishing",async()=>{
  render(<WorldEditor/>);await ready();fireEvent.click(screen.getByRole("button",{name:"Select furnishing in illustration"}));
  fireEvent.change(screen.getByRole("combobox",{name:"Editing floor"}),{target:{value:""}});expect(selected()).toBe("inn");
  fireEvent.change(screen.getByRole("combobox",{name:"Editing floor"}),{target:{value:otherFloor}});expect(selected()).toBe("shop");
  expect(new URLSearchParams(location.search).get("floor")).toBe(otherFloor);
  expect(definition.objects[2]!.placement).toEqual({building_id:"inn",floor_id:floor});
});
it("discards stale object IDs and refuses a restored walk mode when connection loading fails",async()=>{
  window.history.replaceState(null,"","/sketch/world?world=world&place=place&object=deleted&view=walk");connectionError=true;
  render(<WorldEditor/>);await ready();expect(selected()).toBe("");expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("plan");
  expect(new URLSearchParams(location.search).has("object")).toBe(false);
});
it("walks a route handed over from /play, starting once at its first point",async()=>{
  window.history.replaceState(null,"","/sketch/world?world=world&place=place&view=walk&route=-2.00,1.00,0.50%3B3.00,1.00,-1.57%3Bnan,0,0");
  render(<WorldEditor/>);await ready();expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("walk");
  const w=definition.width/2,d=definition.depth/2;
  expect(viewport.props.route).toEqual([{x:w-2,z:d+1,yaw:0.5},{x:w+3,z:d+1,yaw:-1.57}]);
  // "Make walk video" gets the same route.
  expect(walkVideo.props).toMatchObject({placeId:"place",route:viewport.props.route});
  expect(viewport.props.getWalkPose!()).toEqual({version:1,place_id:"place",scene_revision:1,position:{x:w-2,y:0.82,z:d+1},yaw:0.5,pitch:0});
  expect(viewport.props.getWalkPose!()).toBeNull();
  // Consumed: a later reload (save, fork) must not teleport back to the start.
  expect(new URLSearchParams(location.search).has("route")).toBe(false);
});
it("prepares an illustrated canonical route without walking it or overwriting the saved physical position",async()=>{
  window.history.replaceState(null,"","/sketch/world?world=world&place=place&view=walk&workflow=illustrated-walk&route=-2.00,1.00,0.50%3B3.00,1.00,-1.57");
  render(<WorldEditor/>);await ready();
  expect(screen.getByRole("region",{name:"Illustrated walk workspace"})).toBeTruthy();
  expect(screen.getByRole("img",{name:"Saved world artwork"}).getAttribute("src")).toBe("/street.png");
  const w=definition.width/2,d=definition.depth/2;
  expect(walkVideo.props).toMatchObject({placeId:"place",route:[{x:w-2,z:d+1,yaw:0.5},{x:w+3,z:d+1,yaw:-1.57}]});
  expect(viewport.props.route).toBeUndefined();expect(viewport.props.interactionPaused).toBe(true);
  expect(viewport.props.getWalkPose!()).toBeNull();expect(viewport.props.onWalkPose).toBeUndefined();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:"Explore in 3D"}));
  expect(viewport.props.interactionPaused).toBe(false);expect(viewport.props.onWalkPose).toBeTypeOf("function");
  expect(new URLSearchParams(location.search).has("workflow")).toBe(false);
});
it("retains an unprepared illustrated route through reload until the free checkpoints are acknowledged",async()=>{
  window.history.replaceState(null,"","/sketch/world?world=world&place=place&view=walk&workflow=illustrated-walk&route=-2.00,1.00,0.50%3B3.00,1.00,-1.57");
  const ui=render(<WorldEditor/>);await ready();const route=walkVideo.props!.route;
  expect(new URLSearchParams(location.search).has("route")).toBe(true);
  ui.unmount();render(<WorldEditor/>);await ready();expect(walkVideo.props!.route).toEqual(route);
  expect(viewport.props.route).toBeUndefined();expect(viewport.props.onWalkPose).toBeUndefined();
});
it("reopens prepared illustrated checkpoints without restarting the physical route",async()=>{
  window.history.replaceState(null,"","/sketch/world?world=world&place=place&view=walk&workflow=illustrated-walk&walk_views=first,last&camera=first");
  render(<WorldEditor/>);await ready();
  expect(walkVideo.props).toMatchObject({initialViewIds:["first","last"],route:undefined});
  expect(viewport.props.route).toBeUndefined();expect(viewport.props.onWalkPose).toBeUndefined();
  expect(screen.getByRole("button",{name:"Review first checkpoint artwork"})).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("keeps the saved walk library reachable across view switches and a reload without a route",async()=>{
  const ui=render(<WorldEditor/>);await ready();
  expect(screen.getByRole("region",{name:"Saved walk videos"})).toBeTruthy();
  expect(walkVideo.props).toMatchObject({placeId:"place",route:undefined});
  for(const name of ["Plan","Illustration","Plan + 3D"]){
    fireEvent.click(screen.getByRole("button",{name}));
    expect(screen.getByRole("region",{name:"Saved walk videos"})).toBeTruthy();
  }
  ui.unmount();render(<WorldEditor/>);await ready();
  expect(screen.getByRole("region",{name:"Saved walk videos"})).toBeTruthy();
  expect(walkVideo.props).toMatchObject({placeId:"place",route:undefined});
});
it("opens the whole district map separately from artwork, pauses walking without changing mode, and resumes",async()=>{
  vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.open=true;});
  vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.open=false;});
  render(<WorldEditor/>);await ready();fireEvent.click(screen.getByRole("button",{name:"Walk"}));
  expect(viewport.props.interactionPaused).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"World map"}));
  expect(screen.getByRole("dialog",{name:"World map"})).toBeTruthy();expect(viewport.props.interactionPaused).toBe(true);
  expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("walk");
  fireEvent.click(screen.getByRole("button",{name:"Close world map"}));
  expect(viewport.props.interactionPaused).toBe(false);expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("walk");
  expect(screen.getByRole("link",{name:"Repaint map artwork"})).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});
it("opens the selected building's owning place from the full map through the normal GET-only editor navigation",async()=>{
  vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.open=true;});
  vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.open=false;});
  const remote={...scene,id:"remote_scene",place_id:"remote",definition:{...definition,label:"Annex"}};
  const network:PlaceNetwork={chunks:[{scene,x:0,z:0},{scene:remote,x:definition.width,z:0}],connections:[{id:"joined",version:1,kind:"boundary",a:{place_id:"place",side:"east",offset:10},b:{place_id:"remote",side:"west",offset:10},width:3,created_at:scene.updated_at}]};
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>({ok:true,json:async()=>url.endsWith("connections")?{network}:new URL(url,"http://localhost").searchParams.get("place")==="remote"?{session_id:"world",place_id:"remote",source_node_id:"street",source_url:"/street.png",initial:remote.definition,scene:remote,history:[remote],drawing:null}:{session_id:"world",place_id:"place",source_node_id:"street",source_url:"/street.png",initial:definition,scene,history:[scene],drawing:null}})));
  render(<WorldEditor/>);await ready();fireEvent.click(screen.getByRole("button",{name:"World map"}));
  fireEvent.click(screen.getByRole("button",{name:"Select Shop in Annex"}));fireEvent.click(screen.getByRole("button",{name:"Edit selection"}));
  await waitFor(()=>expect(new URLSearchParams(location.search).get("place")).toBe("remote"));
  await waitFor(()=>expect(selected()).toBe("shop"));expect(screen.getByTestId("viewport").getAttribute("data-mode")).toBe("plan");
  expect(screen.queryByRole("dialog",{name:"World map"})).toBeNull();
  expect(vi.mocked(fetch).mock.calls.every(([,init])=>!init?.method||init.method==="GET")).toBe(true);
});

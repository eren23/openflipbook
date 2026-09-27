import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { emptyPlaceScene, newComponent } from "@/lib/place-scene";

vi.mock("next/dynamic",()=>({default:()=>function Viewport({selected,mode,floorId,focusKey}:{selected:string|null;mode:string;floorId?:string;focusKey?:number}){
  return <div data-testid="viewport" data-selected={selected??""} data-mode={mode} data-floor={floorId??""} data-focus={focusKey}/>;
}}));
vi.mock("@/hooks/useWalkPosition",()=>({useWalkPosition:()=>({ready:true,getPose:()=>null,record:()=>{},flush:()=>{},state:{status:"idle"},retry:()=>{}})}));
vi.mock("./mesh-generator",()=>({default:()=>null}));
vi.mock("./place-builder",()=>({default:()=>null}));
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
  connectionError=false;window.history.replaceState(null,"","/sketch/world?world=world&place=place&object=inn&view=orbit&camera=shot");
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

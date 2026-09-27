import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import BuildAppearance from "./build-appearance";
import type { PlaceBuildJob } from "@/lib/place-build";
import type { BuildMaterialStage } from "@/lib/place-build-materials";
const call=vi.fn(),refresh=vi.fn(),preview=vi.fn(),onBusy=vi.fn();
const materialConfig={enabled:true,model:"material",reservation:0.1,parameters:{quality:"tile"}},meshConfig={enabled:true,model:"mesh",reservation:2,parameters:{quality:"mesh"}};
const job:PlaceBuildJob={id:"layout",prompt:"District",model:"planner",reservation:0.2,base_revision:1,status:"ready",created_at:"now",
  material_plan:[{id:"wall",prompt:"Weathered masonry",targets:[]},{id:"roof",prompt:"Green copper",targets:[]}],
  mesh_plan:[{id:"statue",prompt:"Stone statue",role:"exterior",targets:[]},{id:"chair",prompt:"Wooden chair",role:"prop",targets:[]}]};
const stage=(kind:"material"|"mesh",status:BuildMaterialStage["status"]="ready"):BuildMaterialStage=>({id:"approval",status,reservation:kind==="material"?0.2:4,items:(kind==="material"?job.material_plan!:job.mesh_plan!).map(p=>({plan_id:p.id,job:{id:p.id,prompt:p.prompt,model:kind,reservation:0.1,status:status==="ready"?"ready":"running"}}))});
const props=()=>({job:structuredClone(job),materialConfig,meshConfig,disabled:false,stale:false,call,refresh,preview,onBusy});
beforeEach(()=>{call.mockReset();call.mockResolvedValue({});refresh.mockReset();refresh.mockResolvedValue(undefined);preview.mockReset();onBusy.mockReset();});
const consent=()=>fireEvent.click(screen.getByRole("checkbox",{name:"Reserve $4.20 for 2 materials and 2 meshes"}));
it("shows one complete approval, no automatic submission and no individual batch buttons",async()=>{
  render(<BuildAppearance {...props()}/>);expect(call).not.toHaveBeenCalled();expect(screen.queryByRole("button",{name:"Generate build materials"})).toBeNull();
  expect((screen.getByRole("button",{name:"Generate appearance"}) as HTMLButtonElement).disabled).toBe(true);consent();fireEvent.click(screen.getByRole("button",{name:"Generate appearance"}));
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));expect(call).toHaveBeenCalledWith({action:"appearance",id:"layout",request_id:expect.any(String),confirmed:true,total_reservation:4.2,quotes:{material:{model:"material",reservation:0.1,parameters:{quality:"tile"}},mesh:{model:"mesh",reservation:2,parameters:{quality:"mesh"}}}});
});
it("retains identical recovery input after a lost response even when stage reads and quotes change",async()=>{
  const p=props(),view=render(<BuildAppearance {...p}/>);consent();call.mockRejectedValueOnce(new Error("Acknowledgement lost"));fireEvent.click(screen.getByRole("button",{name:"Generate appearance"}));await screen.findByText("Acknowledgement lost");
  view.rerender(<BuildAppearance {...p} stale job={{...p.job,material_stage:stage("material"),mesh_stage:stage("mesh")}} meshConfig={{enabled:false,reason:"offline"}}/>);
  fireEvent.click(screen.getByRole("button",{name:"Retry saved appearance request"}));await waitFor(()=>expect(call).toHaveBeenCalledTimes(2));expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
});
it("preserves the approved request when refreshing after success fails",async()=>{
  render(<BuildAppearance {...props()}/>);consent();refresh.mockRejectedValueOnce(new Error("Status unavailable"));fireEvent.click(screen.getByRole("button",{name:"Generate appearance"}));await screen.findByText("Status unavailable");
  fireEvent.click(screen.getByRole("button",{name:"Retry saved appearance request"}));await waitFor(()=>expect(call).toHaveBeenCalledTimes(2));expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
});
it("clears consent on changed quotes and blocks stale or unavailable generation",async()=>{
  const p=props(),view=render(<BuildAppearance {...p}/>);consent();view.rerender(<BuildAppearance {...p} materialConfig={{...materialConfig,reservation:0.2}}/>);
  expect((screen.getByRole("checkbox",{name:"Reserve $4.40 for 2 materials and 2 meshes"}) as HTMLInputElement).checked).toBe(false);
  view.rerender(<BuildAppearance {...p} stale/>);expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  view.rerender(<BuildAppearance {...p} meshConfig={{enabled:false,reason:"Worker offline"}}/>);await screen.findByText("Meshes: Worker offline");expect((screen.getByRole("button",{name:"Generate appearance"}) as HTMLButtonElement).disabled).toBe(true);expect(call).not.toHaveBeenCalled();
});
it("only approves the missing stage next to an existing independent material stage",async()=>{
  const p=props();render(<BuildAppearance {...p} job={{...p.job,material_stage:stage("material")}}/>);
  fireEvent.click(screen.getByRole("checkbox",{name:"Reserve $4.00 for 2 meshes"}));fireEvent.click(screen.getByRole("button",{name:"Generate remaining appearance"}));
  await waitFor(()=>expect(call).toHaveBeenCalledTimes(1));expect(call.mock.calls[0]![0]).toMatchObject({total_reservation:4,quotes:{mesh:{model:"mesh"}}});expect(call.mock.calls[0]![0].quotes.material).toBeUndefined();
});
it("keeps complete preview disabled until every planned stage is ready, retaining an explicit layout-only option",()=>{
  const p=props(),view=render(<BuildAppearance {...p} job={{...p.job,material_stage:stage("material"),mesh_stage:stage("mesh","generating")}}/>);
  expect((screen.getByRole("button",{name:"Preview complete appearance"}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole("button",{name:"Preview layout only"}));expect(preview).toHaveBeenCalledWith(true);
  view.rerender(<BuildAppearance {...p} job={{...p.job,material_stage:stage("material"),mesh_stage:stage("mesh")}}/>);fireEvent.click(screen.getByRole("button",{name:"Preview complete appearance"}));expect(preview).toHaveBeenCalledWith(false);
});
it("reports a missing approved stage without inviting another generation",()=>{
  const p=props();render(<BuildAppearance {...p} job={{...p.job,appearance_approval:{id:"approval",kinds:["material","mesh"],total_reservation:4.2}}}/>);
  expect(screen.getByRole("alert").textContent).toContain("stage is missing");expect(screen.queryByRole("button",{name:"Generate appearance"})).toBeNull();expect((screen.getByRole("button",{name:"Preview complete appearance"}) as HTMLButtonElement).disabled).toBe(true);expect(call).not.toHaveBeenCalled();
});
it("unlocks a definitively rejected approval only with fresh consent",async()=>{
  render(<BuildAppearance {...props()}/>);consent();call.mockRejectedValueOnce(Object.assign(new Error("Budget reached"),{status:429}));fireEvent.click(screen.getByRole("button",{name:"Generate appearance"}));await screen.findByText("Budget reached");
  expect(screen.queryByRole("button",{name:"Retry saved appearance request"})).toBeNull();expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
});

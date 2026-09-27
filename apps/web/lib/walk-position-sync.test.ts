import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {WalkPositionSync} from "./walk-position-sync";
import type {WalkPose,WalkPositionWrite} from "./walk-position";
const pose:WalkPose={version:1,place_id:"p",scene_revision:1,position:{x:2,y:0.82,z:3},yaw:0,pitch:0};
const reply=(body:string)=>{const v=JSON.parse(body);return Response.json({revision:v.base_revision+1,pose:v.pose});};
beforeEach(()=>vi.useFakeTimers());afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe("position autosave",()=>{
  it("calls the native transport without binding it to the sync instance",async()=>{
    const native=vi.fn(function(this:unknown,_url:unknown,init?:RequestInit){expect(this).toBeUndefined();return Promise.resolve(reply(init!.body as string));});
    vi.stubGlobal("fetch",native);
    const notify=vi.fn(),sync=new WalkPositionSync("/walk",{revision:0,pose:null},notify);
    sync.record(pose);await sync.flush();expect(notify).toHaveBeenLastCalledWith({status:"saved"});expect(native).toHaveBeenCalledTimes(1);sync.close();
  });
  it("coalesces movement and never submits unchanged positions",async()=>{
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>reply(init!.body as string)),notify=vi.fn();
    const sync=new WalkPositionSync("/walk",{revision:0,pose:null},notify,fetch);
    sync.record(pose);sync.record({...pose,yaw:0.2});await vi.advanceTimersByTimeAsync(750);
    expect(fetch).toHaveBeenCalledTimes(1);expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).pose.yaw).toBe(0.2);
    expect(notify).toHaveBeenLastCalledWith({status:"saved"});
    sync.record({...pose,yaw:0.2});await vi.advanceTimersByTimeAsync(1500);expect(fetch).toHaveBeenCalledTimes(1);sync.close();
  });
  it("serializes writes, including the latest pose during close",async()=>{
    let release!:(r:Response)=>void;
    const fetch=vi.fn((_url:unknown,_init?:RequestInit):Promise<Response>=>new Promise(r=>{release=r;}));
    const sync=new WalkPositionSync("/walk",{revision:0,pose:null},()=>{},fetch);
    sync.record(pose);const first=sync.flush();sync.record({...pose,yaw:0.4});sync.close();
    expect(fetch).toHaveBeenCalledTimes(1);release(reply(fetch.mock.calls[0]![1]!.body as string));await first;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({base_revision:1,pose:{yaw:0.4}});
    const second=sync.flush();release(reply(fetch.mock.calls[1]![1]!.body as string));await second;
  });
  it("retains the same request after a lost response and requires explicit retry",async()=>{
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>reply(init!.body as string)).mockRejectedValueOnce(new Error("connection lost")),notify=vi.fn();
    const sync=new WalkPositionSync("/walk",{revision:0,pose:null},notify,fetch);
    sync.record(pose);await sync.flush();sync.record({...pose,yaw:0.2});await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenLastCalledWith({status:"error",message:"connection lost",conflict:false});
    await sync.retry();
    expect(fetch.mock.calls[1]![1]!.body).toBe(fetch.mock.calls[0]![1]!.body);
    await vi.advanceTimersByTimeAsync(750);expect(fetch).toHaveBeenCalledTimes(3);sync.close();
  });
  it("does not overwrite a conflicting tab's saved position",async()=>{
    const fetch=vi.fn(async()=>Response.json({error:"another tab"},{status:409})),notify=vi.fn();
    const sync=new WalkPositionSync("/walk",{revision:0,pose:null},notify,fetch);
    sync.record(pose);await sync.flush();sync.record({...pose,yaw:0.3});await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenLastCalledWith({status:"error",message:"another tab",conflict:true});sync.close();
  });
  it("rejects an invalid acknowledgement instead of advancing its revision",async()=>{
    const requests:WalkPositionWrite[]=[],notify=vi.fn();
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{requests.push(JSON.parse(init!.body as string));return Response.json({revision:99,pose});});
    const sync=new WalkPositionSync("/walk",{revision:0,pose:null},notify,fetch);sync.record(pose);await sync.flush();
    expect(notify).toHaveBeenLastCalledWith({status:"error",message:"Invalid saved-position receipt",conflict:false});
    await sync.retry();expect(requests[1]).toEqual(requests[0]);sync.close();
  });
});

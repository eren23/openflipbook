import type { SavedWalkPosition, WalkPose, WalkPositionWrite } from "./walk-position";

export type PositionSaveState = {status:"idle"|"saved"|"saving"|"error";message?:string;conflict?:boolean};

export class WalkPositionSync {
  private latest: WalkPose | null;
  private acknowledged: string;
  private revision: number;
  private pending: WalkPositionWrite | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private failed = false;
  private closed = false;

  constructor(private url: string, saved: SavedWalkPosition, private notify: (state:PositionSaveState)=>void, private request:typeof fetch=(...args)=>fetch(...args)) {
    this.latest=saved.pose;this.revision=saved.revision;this.acknowledged=JSON.stringify(saved.pose);
  }
  getPose = () => this.latest;
  record = (pose: WalkPose) => {
    if(this.closed)return;
    this.latest=pose;
    if(JSON.stringify(pose)!==this.acknowledged&&!this.failed){this.notify({status:"saving"});this.schedule();}
  };
  private schedule() {
    if(this.timer||this.flight)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.flush();},750);
  }
  flush = (): Promise<void> => {
    if(this.timer){clearTimeout(this.timer);this.timer=null;}
    if(this.flight)return this.flight;
    if(this.failed||!this.latest||(!this.pending&&JSON.stringify(this.latest)===this.acknowledged))return Promise.resolve();
    this.pending??={request_id:crypto.randomUUID(),base_revision:this.revision,pose:this.latest};
    const input=this.pending;
    this.notify({status:"saving"});
    this.flight=(async()=>{
      try{
        const res=await this.request(this.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input),keepalive:true});
        const data=await res.json();
        if(!res.ok)throw Object.assign(new Error(data.error??"Walking position could not be saved"),{status:res.status});
        if(data.revision!==input.base_revision+1||JSON.stringify(data.pose)!==JSON.stringify(input.pose))throw new Error("Invalid saved-position receipt");
        this.revision=data.revision;this.acknowledged=JSON.stringify(input.pose);this.pending=null;
        this.notify({status:"saved"});
      }catch(e){this.failed=true;this.notify({status:"error",message:(e as Error).message,conflict:(e as {status?:number}).status===409});}
    })().finally(()=>{
      this.flight=null;
      if(!this.failed&&JSON.stringify(this.latest)!==this.acknowledged){if(this.closed)void this.flush();else this.schedule();}
    });
    return this.flight;
  };
  retry = () => {this.failed=false;return this.flush();};
  close = () => {this.closed=true;void this.flush();};
}

import { creatorRoute, checkCreatorWrite } from "@/lib/creator";
import { createStreetStep, listStreetSteps } from "@/lib/street-walk-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 420;
type Params = { params: Promise<{ id: string }> };
export async function GET(_req: Request, {params}: Params) { return creatorRoute(async()=>listStreetSteps((await params).id)); }
export async function POST(req: Request, {params}: Params) { return creatorRoute(async()=>{checkCreatorWrite(req);return createStreetStep((await params).id,await req.json());}); }

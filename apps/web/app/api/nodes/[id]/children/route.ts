import { NextResponse } from "next/server";
import { listNodesByParent } from "@/lib/db";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_PUBLIC_BASE_URL) {
    return NextResponse.json(
      { error: "persistence not configured" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 200;

  const rows = await listNodesByParent(id, {
    limit: Number.isFinite(limit) ? limit : 200,
  });
  const publicBase = env.R2_PUBLIC_BASE_URL!.replace(/\/$/, "");

  return NextResponse.json({
    parent_id: id,
    children: rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      query: row.query,
      page_title: row.page_title,
      image_url: `${publicBase}/${row.image_key}`,
      click_in_parent: row.click_in_parent,
      created_at: row.created_at,
    })),
  });
}

import { NextResponse } from "next/server";
import { insertNode } from "@/lib/db";
import { decodeDataUrl, uploadJpeg } from "@/lib/r2";
import { readServerEnv } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateBody {
  parent_id?: string | null;
  session_id: string;
  query: string;
  page_title: string;
  image_data_url: string;
  image_model: string;
  prompt_author_model: string;
  aspect_ratio?: string;
  final_prompt?: string | null;
  click_in_parent?: { x_pct: number; y_pct: number } | null;
}

export async function POST(req: Request) {
  const env = readServerEnv();
  if (!env.MONGODB_URI || !env.MONGODB_DB || !env.R2_BUCKET) {
    return NextResponse.json(
      {
        error:
          "MONGODB_URI/MONGODB_DB or R2_* not set. See docs/BYO-KEYS.md. Persistence is disabled; the generated image is still usable in-memory.",
      },
      { status: 503 }
    );
  }

  const body = (await req.json()) as CreateBody;
  if (!body.image_data_url || !body.session_id || !body.page_title) {
    return NextResponse.json(
      { error: "missing required fields: session_id, page_title, image_data_url" },
      { status: 400 }
    );
  }

  const decoded = decodeDataUrl(body.image_data_url);
  const extension = decoded.contentType === "image/png" ? "png" : "jpg";
  const keyPrefix = body.session_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const objectKey = `${keyPrefix}/${crypto.randomUUID()}.${extension}`;

  const uploaded = await uploadJpeg(objectKey, decoded.bytes, decoded.contentType);

  const row = await insertNode({
    parent_id: body.parent_id ?? null,
    session_id: body.session_id,
    query: body.query,
    page_title: body.page_title,
    image_key: uploaded.key,
    image_model: body.image_model,
    prompt_author_model: body.prompt_author_model,
    aspect_ratio: body.aspect_ratio ?? "16:9",
    final_prompt: body.final_prompt ?? null,
    click_in_parent: body.click_in_parent ?? null,
  });

  return NextResponse.json({
    id: row.id,
    image_url: uploaded.url,
    created_at: row.created_at,
  });
}

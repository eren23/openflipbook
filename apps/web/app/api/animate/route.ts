import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const modalUrl = process.env.MODAL_API_URL;
  if (!modalUrl) {
    return NextResponse.json(
      { error: "MODAL_API_URL not set." },
      { status: 503 }
    );
  }
  const body = await req.text();
  const upstream = await fetch(
    `${modalUrl.replace(/\/$/, "")}/animate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

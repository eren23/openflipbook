import { notFound } from "next/navigation";
import PublishedWorld from "@/components/published-world";
import { readPublication } from "@/lib/world-publication";
import { CreatorError } from "@/lib/creator-error";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  try { return <PublishedWorld world={await readPublication((await params).id)} />; }
  catch (e) { if (e instanceof CreatorError && e.status === 404) notFound(); throw e; }
}

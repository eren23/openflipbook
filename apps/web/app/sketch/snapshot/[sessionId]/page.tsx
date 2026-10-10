import PublishedWorld from "@/components/published-world";
import { publicationLibrary } from "@/lib/world-publication";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params; return <PublishedWorld world={await publicationLibrary(sessionId)} privateSession={sessionId} />;
}

import { notFound } from "next/navigation";
import { sketchEnabled } from "@/lib/sketch-server";
import SketchWorkspace from "@/components/sketch/sketch-workspace";
export const dynamic = "force-dynamic";
export default function SketchPage() {
  if (!sketchEnabled()) notFound();
  return <SketchWorkspace />;
}

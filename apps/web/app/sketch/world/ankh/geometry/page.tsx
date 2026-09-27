import { notFound } from "next/navigation";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import DrumGeometry from "@/components/sketch/drum-geometry";

export default function DrumGeometryPage() {
  if (!placeScenesEnabled()) notFound();
  return <DrumGeometry />;
}

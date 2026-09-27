import { notFound } from "next/navigation";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import DrumEnvironment from "@/components/sketch/drum-environment";

export default function DrumEnvironmentPage() {
  if (!placeScenesEnabled()) notFound();
  return <DrumEnvironment />;
}

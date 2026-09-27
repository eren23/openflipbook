import { notFound } from "next/navigation";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
import MapArtworkEditor from "@/components/sketch/map-artwork-editor";
export default function MapArtworkPage() { if (!placeScenesEnabled()) notFound(); return <MapArtworkEditor />; }

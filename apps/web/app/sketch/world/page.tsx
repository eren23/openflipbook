import WorldEditor from "@/components/sketch/world-editor";
import { notFound } from "next/navigation";
import { placeScenesEnabled } from "@/lib/place-scene-enabled";
export default function WorldEditorPage() { if (!placeScenesEnabled()) notFound(); return <WorldEditor />; }

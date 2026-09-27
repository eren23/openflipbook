import { notFound } from "next/navigation";
import GeometryStudy from "./study";

export default function Page() {
  if (process.env.SPATIAL_STUDY !== "1" || process.env.NODE_ENV === "production") notFound();
  return <GeometryStudy />;
}

import { notFound } from "next/navigation";
import SpatialStudy from "./study";

export default function Page() {
  if (process.env.SPATIAL_STUDY !== "1" || process.env.NODE_ENV === "production") notFound();
  return <SpatialStudy />;
}

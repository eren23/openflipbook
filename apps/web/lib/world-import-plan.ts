import type { Document } from "mongodb";

export interface WorldImportPlan {
  session_id: string;
  title: string;
  records: Record<string, Document[]>;
  uploads: { key: string; bytes: Buffer; contentType: string }[];
  preview: { title: string; pages: number; places: number; objects: number; meshes: number; materials: number; views: number; illustrations: number; motion_studies: number; clips: number; source_session_id: string };
}

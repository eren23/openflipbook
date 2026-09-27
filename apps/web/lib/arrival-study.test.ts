import { afterEach, describe, expect, it, vi } from "vitest";
import { ARRIVAL_POLICIES, arrivalAssetPath, arrivalStatus, type ArrivalCell } from "./arrival-study";
import { SPATIAL_STUDY_CASES } from "./spatial-study";
import { GET } from "@/app/api/dev/arrival-assets/[file]/route";
const read = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: read, default: { readFile: read } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("arrival evidence", () => {
  it("allowlists only fixed sources, review crops, manifest and trial outputs", () => {
    expect(arrivalAssetPath("manifest.json")).toContain("arrival-audit");
    for (const c of SPATIAL_STUDY_CASES) {
      expect(arrivalAssetPath(c.source)).toContain("fixtures/images/real");
      expect(arrivalAssetPath(`${c.id}-review.png`)).toContain("arrival-audit");
      for (const policy of ARRIVAL_POLICIES) for (const run of [1, 2]) {
        expect(arrivalAssetPath(`${c.id}-${policy}-${run}-candidate.png`)).not.toBeNull();
        expect(arrivalAssetPath(`${c.id}-${policy}-${run}-runtime.png`)).not.toBeNull();
      }
    }
    for (const path of ["../.env", "ledger.json", "unknown.png", "fishing_lighthouse-context_first-3-candidate.png"]) expect(arrivalAssetPath(path)).toBeNull();
  });
  it("requires every judge and human review, never just the arrival score", () => {
    const cell: ArrivalCell = { id: "x", case_id: "x", policy: "target_first", run: 1, state: "not_submitted", arrival: null, human_review: null, view_verdict: null, output_sha256: null };
    expect(arrivalStatus(cell)).toBe("not submitted"); cell.state = "complete";
    expect(arrivalStatus(cell)).toBe("Not verified"); cell.output_sha256 = "hash";
    cell.arrival = { status: "pass", checks: { near_target: "pass", exterior: "pass", single_target: "pass", scene_not_map: "pass" }, rationale: "checked" };
    expect(arrivalStatus(cell)).toBe("Not verified");
    cell.view_verdict = { accepted: true, attempts: 1, same_place: 8, medium: 8, detail: 8, conformance: 8, interior: null, arrival: cell.arrival };
    expect(arrivalStatus(cell)).toBe("Human review pending");
    cell.human_review = { accepted: false, rationale: "wrong entrance" }; expect(arrivalStatus(cell)).toBe("Human review failed");
    cell.human_review.accepted = true; expect(arrivalStatus(cell)).toBe("Reviewed pass");
  });
  it("serves private artifacts only in the explicitly enabled development surface", async () => {
    const get = (file: string) => GET(new Request("http://local"), { params: Promise.resolve({ file }) });
    vi.stubEnv("SPATIAL_STUDY", "1"); vi.stubEnv("NODE_ENV", "production"); expect((await get("manifest.json")).status).toBe(404);
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SPATIAL_STUDY", "0"); expect((await get("manifest.json")).status).toBe(404);
    vi.stubEnv("SPATIAL_STUDY", "1"); expect((await get("../.env")).status).toBe(404);
    read.mockResolvedValue(Buffer.from("artifact"));
    for (const [file, type] of [["manifest.json", "application/json"], ["fishing_lighthouse-review.png", "image/png"], ["fishing_village.jpg", "image/jpeg"]]) {
      const response = await get(file!); expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe(type); expect(response.headers.get("cache-control")).toContain("no-store");
    }
    read.mockRejectedValue(new Error("not found")); expect((await get("manifest.json")).status).toBe(404);
  });
});

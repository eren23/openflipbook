import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ArrivalStudy from "./arrival-study";

const c = (id: string) => ({ id, title: id, source: `${id}.jpg`, click: { x_pct: .2, y_pct: .3 }, review: { bbox: [.1, .1, .2, .4], features: ["Stone tower"], entrance: "Unknown", provenance: "human_evaluation_only" }, runtime_reference: null });
const report = { version: 1, fingerprint: "hash", cases: [c("one"), c("two")], cells: [{ id: "one-context_first-1", case_id: "one", policy: "context_first", run: 1, state: "not_submitted", output_sha256: null }], reserved_usd: "0.00", approved_cap_usd: "0.00", model: "fixture" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows real input images, evaluation-only crops and unsubmitted trials", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(report))));
  render(<ArrivalStudy />); await screen.findByRole("img", { name: "one" });
  expect(screen.getByText("Human annotations: evaluation only")).toBeDefined();
  expect(screen.getByText("Not captured")).toBeDefined();
  expect(screen.getByText("not submitted")).toBeDefined();
  fireEvent.click(screen.getByRole("tab", { name: "two" })); expect(screen.getByRole("img", { name: "two" })).toBeDefined();
  expect(screen.getByRole("link", { name: "Download manifest" }).getAttribute("href")).toContain("manifest.json");
});
it("can retry an unavailable audit without inventing results", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 404 })).mockResolvedValueOnce(new Response(JSON.stringify(report))));
  render(<ArrivalStudy />); await screen.findByText("Arrival audit unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Reload audit" })); await screen.findByRole("img", { name: "one" });
});
it("rejects malformed manifests", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 2 }))));
  render(<ArrivalStudy />); await screen.findByText("Invalid arrival audit");
});
it("shows an actual automatic crop and labels assistant review separately", async () => {
  const live = { ...report, reserved_usd: "1.9464306525", cases: [{ ...c("one"), runtime_reference: { provenance: "first_seen", source_sha256: "abcd", asset: "one-context_first-1-runtime.png" } }], cells: [{ ...report.cells[0], visual_review: { reviewer: "assistant", accepted: false, rationale: "Aerial, not eye-level" } }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(live))));
  render(<ArrivalStudy />);
  await screen.findByRole("img", { name: "one automatic reference" });
  expect(screen.getByText("Reserved $1.95")).toBeDefined();
  expect(screen.getByText(/assistant review:/)).toBeDefined();
  expect(screen.queryByText("Reviewed pass")).toBeNull();
});

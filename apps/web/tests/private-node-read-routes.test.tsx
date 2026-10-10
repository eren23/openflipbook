// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { CreatorError } from "@/lib/creator-error";

const state = vi.hoisted(() => ({
  row: { id: "node", session_id: "private-world", parent_id: null, query: "Private query", page_title: "Private title", image_key: "private.jpg", sources: [], created_at: "2026-01-01T00:00:00Z" },
  read: vi.fn(), children: vi.fn(), stored: vi.fn(), qr: vi.fn(), chain: [] as { id: string; session_id: string; parent_id: null; query: string; page_title: string; image_key: string; sources: never[]; created_at: string }[],
}));
vi.mock("@/lib/db", () => ({ getNode: async () => state.row, listNodesByParent: state.children, getNodeChain: async () => state.chain }));
vi.mock("@/lib/env", () => ({ readServerEnv: () => ({ MONGODB_URI: "mock", MONGODB_DB: "mock", R2_PUBLIC_BASE_URL: "https://images.test" }) }));
vi.mock("@/lib/world-access", () => ({ requireWorldRead: state.read }));
vi.mock("@/lib/r2", () => ({ getStoredBytes: state.stored }));
vi.mock("@/lib/export-build", () => ({ buildZip: async () => new Uint8Array([1]), buildFlipbookPdf: async () => new Uint8Array([2]), buildGif: async () => new Uint8Array([3]), sampleEvenly: () => [0] }));
vi.mock("qrcode", () => ({ default: { toDataURL: state.qr } }));
vi.mock("@/lib/postcard", () => ({ postcardLayout: () => null }));
vi.mock("next/og", () => ({ ImageResponse: class extends Response { constructor(_body: unknown, options: ResponseInit) { super("postcard", options); } } }));
vi.mock("@/components/fork-button", () => ({ default: () => null }));
vi.mock("@/components/tour-button", () => ({ default: () => null }));
vi.mock("@/components/permalink-image", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

import { GET as nodeGET } from "@/app/api/nodes/[id]/route";
import { GET as childrenGET } from "@/app/api/nodes/[id]/children/route";
import { GET as imageGET } from "@/app/api/image/[nodeId]/route";
import { GET as postcardGET } from "@/app/api/postcard/[nodeId]/route";
import { GET as exportGET } from "@/app/api/export/[nodeId]/route";
import PermalinkPage, { generateMetadata } from "@/app/n/[id]/page";

const request = new Request("http://localhost/api");
const byId = { params: Promise.resolve({ id: "node" }) };
const byNodeId = { params: Promise.resolve({ nodeId: "node" }) };
const readers = [
  ["node metadata", () => nodeGET(request, byId)],
  ["children", () => childrenGET(request, byId)],
  ["raw image", () => imageGET(request, byNodeId)],
  ["postcard", () => postcardGET(request, byNodeId)],
  ["export", () => exportGET(request, byNodeId)],
] as const;

beforeEach(() => {
  state.chain = [state.row];
  state.read.mockReset().mockResolvedValue(undefined);
  state.children.mockReset().mockResolvedValue([state.row]);
  state.stored.mockReset().mockResolvedValue({ bytes: new Uint8Array([1]), contentType: "image/jpeg" });
  state.qr.mockReset().mockResolvedValue("data:image/png;base64,AA==");
});

it.each(readers)("denies private %s before reading any child list, blob, or QR", async (_name, read) => {
  state.read.mockRejectedValue(new CreatorError("Not owner", 403));
  const response = await read();
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Not owner" });
  expect(state.read).toHaveBeenCalledWith("private-world");
  expect(state.children).not.toHaveBeenCalled();
  expect(state.stored).not.toHaveBeenCalled();
  expect(state.qr).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
});

it.each(readers)("allows authorized or legacy-public %s without a shared cache", async (_name, read) => {
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
});

it("does not expose a private permalink title or image through page metadata", async () => {
  state.read.mockRejectedValue(new CreatorError("Not owner", 403));
  expect(await generateMetadata(byId)).toEqual({ title: "Page not found", robots: { index: false, follow: false } });
  await expect(PermalinkPage(byId)).rejects.toThrow("not found");
});

it("sanitizes access-check failures without returning storage or database details", async () => {
  state.read.mockRejectedValue(new Error("secret Mongo connection"));
  const response = await nodeGET(request, byId);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "World unavailable" });
});

it("checks every world in an export chain before opening any image", async () => {
  state.chain = [{ ...state.row, id: "ancestor", session_id: "other-private-world" }, state.row];
  state.read.mockImplementation(async (id: string) => { if (id === "other-private-world") throw new CreatorError("Not owner", 403); });
  expect((await exportGET(request, byNodeId)).status).toBe(403);
  expect(state.stored).not.toHaveBeenCalled();
});

it("excludes malformed child rows from another world", async () => {
  state.children.mockResolvedValue([state.row, { ...state.row, id: "foreign", session_id: "other-private-world" }]);
  const response = await childrenGET(request, byId);
  const result = await response.json();
  expect(result.children.map((row: { id: string }) => row.id)).toEqual(["node"]);
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import MeshImporter from "./mesh-importer";
const fetcher = vi.fn(), imported = vi.fn(), asset = { id: "import_hash", prompt: "Test.glb", model: "imported/glb", sha256: "hash" };
beforeEach(() => { fetcher.mockReset(); imported.mockReset(); vi.stubGlobal("fetch", fetcher); });
function select() { const file = new File([new Uint8Array([1, 2, 3])], "Test.glb", { type: "model/gltf-binary" }); fireEvent.change(screen.getByLabelText("GLB file"), { target: { files: [file] } }); return file; }
it("imports exact bytes without a reservation or generation request", async () => {
  fetcher.mockResolvedValue(Response.json({ asset })); render(<MeshImporter sessionId="world" onImported={imported}/>);
  const file = select(); expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Import GLB" }));
  await screen.findByText("GLB validated and saved"); expect(imported).toHaveBeenCalledWith(asset);
  expect(fetcher.mock.calls[0]![0]).toBe("/api/world/world/meshes/import"); expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: "POST", body: file, headers: { "X-Mesh-Filename": "Test.glb", "Content-Type": "model/gltf-binary" } });
  expect(screen.queryByRole("checkbox")).toBeNull();
});
it("retains a failed upload for identical-file retry", async () => {
  fetcher.mockRejectedValueOnce(new Error("Lost acknowledgement")).mockResolvedValue(Response.json({ asset }));
  render(<MeshImporter sessionId="world" onImported={imported}/>); select(); fireEvent.click(screen.getByRole("button", { name: "Import GLB" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry GLB import" })); await screen.findByText("GLB validated and saved");
  expect(fetcher.mock.calls[1]![1].body).toBe(fetcher.mock.calls[0]![1].body); expect(imported).toHaveBeenCalledTimes(1);
});
it("aborts an in-flight upload when leaving the panel without applying its result to another world", async () => {
  let finish!: (value: Response) => void; fetcher.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<MeshImporter sessionId="world" onImported={imported}/>); select(); fireEvent.click(screen.getByRole("button", { name: "Import GLB" }));
  view.unmount(); expect(fetcher.mock.calls[0]![1].signal.aborted).toBe(true); finish(Response.json({ asset }));
  await waitFor(() => expect(imported).not.toHaveBeenCalled());
});

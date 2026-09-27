import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorldImporter from "./world-importer";
const preview = { request_id: "request", sha256: "digest", status: "preview", session_id: "world", preview: { title: "Restored district", pages: 0, places: 2, objects: 8, meshes: 3, materials: 4, views: 2, illustrations: 2 } };
const reply = (value: unknown, status = 200) => ({ ok: status < 400, json: async () => value });
beforeEach(() => {
  localStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
it("inspects an archive and requires separate explicit confirmation before publishing", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(preview)).mockResolvedValueOnce(reply({ ...preview, status: "applied" }));
  vi.stubGlobal("fetch", fetcher); const changed = vi.fn(); render(<WorldImporter onImported={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Import World" }));
  fireEvent.change(screen.getByLabelText("World archive"), { target: { files: [new File(["zip"], "world.zip", { type: "application/zip" })] } });
  await screen.findByRole("button", { name: "Import as private world" }); expect(fetcher).toHaveBeenCalledTimes(2); expect(changed).not.toHaveBeenCalled();
  expect(screen.getByText("Restored district")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import as private world" }));
  await screen.findByText("Private world saved"); expect(changed).toHaveBeenCalledTimes(1); expect(localStorage.getItem("ofb_world_import_pending")).toBeNull();
  expect(fetcher.mock.calls[2]![1].body).toBe(JSON.stringify({ action: "apply", sha256: "digest" }));
});
it("retains the exact confirmation after a lost response and guards double clicks", async () => {
  localStorage.setItem("ofb_world_import_pending", "request");
  const fetcher = vi.fn().mockResolvedValueOnce(reply(preview)).mockRejectedValueOnce(new Error("Response lost")).mockResolvedValueOnce(reply({ ...preview, status: "applied" }));
  vi.stubGlobal("fetch", fetcher); render(<WorldImporter onImported={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume import" }));
  const button = screen.getByRole("button", { name: "Import as private world" }); fireEvent.click(button); fireEvent.click(button);
  await screen.findByRole("alert"); expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(button); await screen.findByText("Private world saved");
  expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[2]);
});
it("retries inspection with the same file and request identity without auto-applying", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({})).mockRejectedValueOnce(new Error("Upload response lost")).mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply(preview));
  vi.stubGlobal("fetch", fetcher); render(<WorldImporter onImported={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Import World" }));
  fireEvent.change(screen.getByLabelText("World archive"), { target: { files: [new File(["zip"], "world.zip")] } });
  fireEvent.click(await screen.findByRole("button", { name: "Retry inspection" }));
  await screen.findByRole("button", { name: "Import as private world" }); expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[3]);
});
it("rejects oversized files locally and shows server validation failures", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ error: "Broken checksum" }, 422));
  vi.stubGlobal("fetch", fetcher); render(<WorldImporter onImported={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Import World" }));
  const file = new File(["x"], "too-large.zip"); Object.defineProperty(file, "size", { value: 385 * 1024 * 1024 });
  fireEvent.change(screen.getByLabelText("World archive"), { target: { files: [file] } });
  expect(screen.getByRole("alert").textContent).toContain("384 MiB"); expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("World archive"), { target: { files: [new File(["zip"], "broken.zip")] } });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Broken checksum"));
});

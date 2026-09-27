import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import WorldRecovery from "./world-recovery";
const reply = (data: unknown, status = 200) => ({ ok: status < 400, json: async () => data });
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
it("requires explicit confirmation, establishes identity first and clears the secret on success", async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ recovered: true })), changed = vi.fn(); vi.stubGlobal("fetch", fetcher);
  render(<WorldRecovery onRecovered={changed} />); fireEvent.click(screen.getByRole("button", { name: "Recover World" }));
  fireEvent.change(screen.getByLabelText("Operator recovery code"), { target: { value: " private-code " } });
  expect(fetcher).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Restore access" }));
  await screen.findByText("Access restored"); expect(changed).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(["/api/creator/identity", "/api/creator/recovery"]);
  expect(fetcher.mock.calls[1]![1].body).toBe(JSON.stringify({ code: "private-code" }));
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Done" })); fireEvent.click(screen.getByRole("button", { name: "Recover World" }));
  expect((screen.getByLabelText("Operator recovery code") as HTMLInputElement).value).toBe("");
});
it("keeps the same code for a lost-response retry and ignores double submission", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(reply({})).mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue(reply({ recovered: true })); vi.stubGlobal("fetch", fetcher);
  render(<WorldRecovery onRecovered={() => {}} />); fireEvent.click(screen.getByRole("button", { name: "Recover World" }));
  fireEvent.change(screen.getByLabelText("Operator recovery code"), { target: { value: "original-code" } });
  const button = screen.getByRole("button", { name: "Restore access" }); fireEvent.click(button); fireEvent.click(button);
  await screen.findByRole("alert"); expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(button); await screen.findByText("Access restored"); expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[3]);
});
it("does not redeem when identity initialization fails and erases cancelled input", async () => {
  const fetcher = vi.fn().mockResolvedValue(reply({ error: "Persistence unavailable" }, 503)); vi.stubGlobal("fetch", fetcher);
  render(<WorldRecovery onRecovered={() => {}} />); fireEvent.click(screen.getByRole("button", { name: "Recover World" }));
  fireEvent.change(screen.getByLabelText("Operator recovery code"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Restore access" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Persistence unavailable")); expect(fetcher).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Recover World" }));
  expect((screen.getByLabelText("Operator recovery code") as HTMLInputElement).value).toBe("");
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Entity } from "@openflipbook/config";

import { CodexPanel } from "./CodexPanel";

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: overrides.id ?? "e1",
    kind: overrides.kind ?? "person",
    name: overrides.name ?? "Mira",
    aliases: overrides.aliases ?? [],
    appearance: overrides.appearance ?? "tall keeper in navy coat",
    reference_image_url: overrides.reference_image_url ?? null,
    facts: overrides.facts ?? [],
    state: overrides.state ?? {},
    first_seen_node_id: overrides.first_seen_node_id ?? "n1",
    last_seen_node_id: overrides.last_seen_node_id ?? "n1",
    appears_on_node_ids: overrides.appears_on_node_ids ?? ["n1"],
    appearance_bboxes: overrides.appearance_bboxes ?? {},
    pinned_by_user: overrides.pinned_by_user ?? false,
    confidence: overrides.confidence ?? 0.8,
    updated_at: overrides.updated_at ?? "2026-05-17T00:00:00Z",
  };
}

describe("CodexPanel", () => {
  it("renders an empty hint when the registry has no entities", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[]}
        loading={false}
        error={null}
      />
    );
    expect(screen.getByText("Codex")).toBeTruthy();
    expect(screen.getByText("no entities yet")).toBeTruthy();
  });

  it("lists entities and their appearance descriptors", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[
          entity({ id: "a", name: "Mira", appearance: "navy peacoat" }),
          entity({
            id: "b",
            kind: "place",
            name: "Lantern Room",
            appearance: "glass-walled chamber",
          }),
        ]}
        loading={false}
        error={null}
      />
    );
    expect(screen.getByText("Mira")).toBeTruthy();
    expect(screen.getByText("navy peacoat")).toBeTruthy();
    expect(screen.getByText("Lantern Room")).toBeTruthy();
    expect(screen.getByText("glass-walled chamber")).toBeTruthy();
  });

  it("filters by kind when a tab is selected", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[
          entity({ id: "a", name: "Mira", kind: "person" }),
          entity({ id: "b", name: "Lantern Room", kind: "place" }),
        ]}
        loading={false}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Places \(1\)/ }));
    expect(screen.queryByText("Mira")).toBeNull();
    expect(screen.getByText("Lantern Room")).toBeTruthy();
  });

  it("sorts pinned entries to the top regardless of recency", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[
          entity({
            id: "a",
            name: "Recent",
            pinned_by_user: false,
            updated_at: "2026-05-20T00:00:00Z",
          }),
          entity({
            id: "b",
            name: "Pinned Old",
            pinned_by_user: true,
            updated_at: "2025-01-01T00:00:00Z",
          }),
        ]}
        loading={false}
        error={null}
      />
    );
    const names = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(names[0]).toBe("Pinned Old");
    expect(names[1]).toBe("Recent");
  });

  it("renders a 'resolving…' state for entities without an appearance yet", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity({ appearance: "" })]}
        loading={false}
        error={null}
      />
    );
    expect(screen.getByText("resolving…")).toBeTruthy();
  });

  it("renders facts and state badges when present", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[
          entity({
            facts: ["opened the lantern room", "wears a peacoat"],
            state: { lantern_room: "open", lit: true },
          }),
        ]}
        loading={false}
        error={null}
      />
    );
    expect(screen.getByText("opened the lantern room")).toBeTruthy();
    expect(screen.getByText("lantern_room: open")).toBeTruthy();
    expect(screen.getByText("lit: true")).toBeTruthy();
  });

  it("fires onClose when the Close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <CodexPanel
        open
        onClose={onClose}
        entities={[]}
        loading={false}
        error={null}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /close codex/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces error messages instead of the entity list", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[]}
        loading={false}
        error="HTTP 502"
      />
    );
    expect(screen.getByText("HTTP 502")).toBeTruthy();
  });

  it("hides edit controls when overrideEnabled is false", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity()]}
        loading={false}
        error={null}
      />
    );
    expect(screen.queryByRole("button", { name: /^Pin$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/i })).toBeNull();
  });

  it("shows edit controls when overrideEnabled and onMutate are wired", () => {
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity()]}
        loading={false}
        error={null}
        overrideEnabled
        onMutate={() => Promise.resolve({ ok: true })}
      />
    );
    expect(screen.getByRole("button", { name: /^Pin$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rename/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy();
  });

  it("fires onMutate with a pin op when Pin is clicked", async () => {
    const onMutate = vi.fn().mockResolvedValue({ ok: true });
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity({ pinned_by_user: false })]}
        loading={false}
        error={null}
        overrideEnabled
        onMutate={onMutate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pin$/ }));
    expect(onMutate).toHaveBeenCalledWith({
      op: "pin",
      id: "e1",
      pinned: true,
    });
  });

  it("displays an inline error when a mutation fails", async () => {
    const onMutate = vi.fn().mockResolvedValue({
      ok: false,
      error: "world override CRUD is disabled",
    });
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity()]}
        loading={false}
        error={null}
        overrideEnabled
        onMutate={onMutate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /^Pin$/ }));
    expect(
      await screen.findByText("world override CRUD is disabled")
    ).toBeTruthy();
  });

  it("disables Delete when the entity is pinned", () => {
    // Phase 7c — pinned-delete guard. The user's whole curation surface
    // can be lost in one mis-click without this; tooltip explains why.
    const onMutate = vi.fn().mockResolvedValue({ ok: true });
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity({ pinned_by_user: true })]}
        loading={false}
        error={null}
        overrideEnabled
        onMutate={onMutate}
      />
    );
    const del = screen.getByRole("button", { name: /Delete/ });
    expect(del.hasAttribute("disabled")).toBe(true);
  });

  it("toggles a rename input that submits on Enter", () => {
    const onMutate = vi.fn().mockResolvedValue({ ok: true });
    render(
      <CodexPanel
        open
        onClose={() => {}}
        entities={[entity({ name: "Mira" })]}
        loading={false}
        error={null}
        overrideEnabled
        onMutate={onMutate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }));
    const input = screen.getByLabelText("Rename entity");
    fireEvent.change(input, { target: { value: "Marian" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onMutate).toHaveBeenCalledWith({
      op: "rename",
      id: "e1",
      name: "Marian",
    });
  });
});

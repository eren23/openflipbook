import { describe, expect, it } from "vitest";
import { NOTE_LIMIT, parseNote, parseWorldPatch } from "./creator-types";

describe("creator validation", () => {
  it("accepts plain notes and explicit empty-note saves", () => {
    expect(parseNote({ place_id: null, text: "<script>not executable</script>", revision: 0 })?.text).toContain("<script>");
    expect(parseNote({ place_id: "geo_1", text: "", revision: 1 })).toEqual({ place_id: "geo_1", text: "", revision: 1 });
  });
  it("rejects unsafe IDs, invalid revisions and oversized notes", () => {
    for (const value of [null, [], {}, { place_id: "$bad", text: "", revision: 0 }, { place_id: 3, text: "", revision: 0 }, { place_id: null, text: "x".repeat(NOTE_LIMIT + 1), revision: 0 }, { place_id: null, text: "", revision: -1 }, { place_id: null, text: "", revision: .5 }, { place_id: null, text: 3, revision: 0 }]) expect(parseNote(value)).toBeNull();
  });
  it("allows only library metadata and validated resume IDs", () => {
    expect(parseWorldPatch({ title: "  Port  ", pinned: true, archived: false, resume_node_id: "n1" })).toEqual({ title: "Port", pinned: true, archived: false, resume_node_id: "n1" });
    for (const value of [null, [], {}, { owner_token: "other" }, { title: " " }, { title: "x".repeat(161) }, { pinned: "true" }, { resume_node_id: "a.b" }]) expect(parseWorldPatch(value)).toBeNull();
  });
});

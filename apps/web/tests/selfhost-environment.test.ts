import { describe, expect, it } from "vitest";
import { assertSelfhostReceipt, type SelfhostReceipt } from "../e2e/selfhost-environment";

const fixture = (): SelfhostReceipt => ({ project: "ofb-check-123456abcdef", compose_file: "/fixture/compose.json",
  origin: "http://127.0.0.1:23456", mongo: "mongodb://127.0.0.1:23457/?directConnection=true", database: "selfhost_check", fixture_providers: true });
describe("selfhost receipt boundary", () => {
  it("accepts the isolated fixture and refuses nonfixture project metadata", () => {
    const receipt = fixture(); expect(() => assertSelfhostReceipt(receipt, receipt.origin)).not.toThrow();
    for (const changed of [{ project: "openflipbook" }, { database: "live" }, { fixture_providers: false }]) {
      const bad = { ...receipt, ...changed }; expect(() => assertSelfhostReceipt(bad, bad.origin)).toThrow(/isolated/);
    }
  });
  it("refuses nonloopback services and a different browser origin before connection", () => {
    const receipt = fixture();
    for (const changed of [{ mongo: "mongodb://live-mongo:27017" }, { origin: "http://other-web:3000" }]) {
      const bad = { ...receipt, ...changed }; expect(() => assertSelfhostReceipt(bad, bad.origin)).toThrow(/isolated/);
    }
    expect(() => assertSelfhostReceipt(receipt, "http://127.0.0.1:11111")).toThrow(/isolated/);
    expect(() => assertSelfhostReceipt(receipt, undefined)).toThrow(/isolated/);
  });
});

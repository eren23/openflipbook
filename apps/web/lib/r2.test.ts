import { describe, expect, it } from "vitest";

import { r2ClientConfig, storedKeyFromUrl } from "./r2";

/**
 * M4 — the blob endpoint seam. With no override the client derives the
 * Cloudflare R2 endpoint from the account id (virtual-host style, today's
 * behavior). With an explicit endpoint (e.g. a Minio container) it uses that
 * verbatim and switches to path-style, which Minio requires. Pure config so
 * it's tested without constructing a network client.
 */

const creds = { accessKeyId: "ak", secretAccessKey: "sk" };

describe("r2ClientConfig", () => {
  it("derives the Cloudflare endpoint + virtual-host style when no override is set", () => {
    const cfg = r2ClientConfig({ ...creds, accountId: "acct123", endpoint: null });
    expect(cfg.endpoint).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(cfg.forcePathStyle).toBe(false);
    expect(cfg.credentials).toEqual(creds);
    expect(cfg.region).toBe("auto");
  });

  it("uses the explicit endpoint + path-style (Minio) when one is set", () => {
    const cfg = r2ClientConfig({
      ...creds,
      accountId: null,
      endpoint: "http://minio:9000",
    });
    expect(cfg.endpoint).toBe("http://minio:9000");
    expect(cfg.forcePathStyle).toBe(true);
  });
});

describe("storedKeyFromUrl", () => {
  it("extracts keys under our public base (and only ours)", () => {
    const base = "http://localhost:9000/openflipbook";
    expect(
      storedKeyFromUrl(`${base}/session_a/page-1.jpg`, base),
    ).toBe("session_a/page-1.jpg");
    expect(storedKeyFromUrl(`${base}/a/b.jpg?x=1#y`, `${base}/`)).toBe("a/b.jpg");
    expect(storedKeyFromUrl("https://elsewhere.com/a.jpg", base)).toBeNull();
    expect(storedKeyFromUrl(`${base}/`, base)).toBeNull();
    expect(storedKeyFromUrl("data:image/jpeg;base64,xxx", base)).toBeNull();
  });
});

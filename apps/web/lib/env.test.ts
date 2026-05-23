import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvMissingError, readServerEnv, requireMongo, requireR2 } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

const ALL_KEYS = [
  "MODAL_API_URL",
  "MONGODB_URI",
  "MONGODB_DB",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
] as const;

function stubAll(value: string): void {
  for (const k of ALL_KEYS) vi.stubEnv(k, value);
}

function stubAllEmpty(): void {
  for (const k of ALL_KEYS) vi.stubEnv(k, "");
}

describe("readServerEnv", () => {
  it("returns all configured values when every var is set", () => {
    stubAll("x");
    const env = readServerEnv();
    expect(env).toEqual({
      MODAL_API_URL: "x",
      MONGODB_URI: "x",
      MONGODB_DB: "x",
      R2_ACCOUNT_ID: "x",
      R2_ACCESS_KEY_ID: "x",
      R2_SECRET_ACCESS_KEY: "x",
      R2_BUCKET: "x",
      R2_PUBLIC_BASE_URL: "x",
    });
  });

  it("returns nulls when env vars are empty strings", () => {
    stubAllEmpty();
    const env = readServerEnv();
    for (const k of ALL_KEYS) {
      expect(env[k]).toBeNull();
    }
  });
});

describe("EnvMissingError", () => {
  it("is named EnvMissingError and lists missing keys in the message", () => {
    const err = new EnvMissingError(["A", "B"]);
    expect(err.name).toBe("EnvMissingError");
    expect(err.message).toBe("Missing required env vars: A, B");
    expect(err.message.startsWith("Missing required env vars: ")).toBe(true);
  });
});

describe("requireR2", () => {
  it("returns unwrapped R2 config when every key is present", () => {
    stubAll("present");
    const env = readServerEnv();
    expect(requireR2(env)).toEqual({
      accountId: "present",
      accessKeyId: "present",
      secretAccessKey: "present",
      bucket: "present",
      publicBaseUrl: "present",
    });
  });

  const r2Keys = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_BASE_URL",
  ] as const;

  for (const missing of r2Keys) {
    it(`throws EnvMissingError listing only ${missing} when only it is missing`, () => {
      stubAll("present");
      vi.stubEnv(missing, "");
      const env = readServerEnv();
      try {
        requireR2(env);
        throw new Error("expected requireR2 to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(EnvMissingError);
        expect((e as Error).message).toBe(
          `Missing required env vars: ${missing}`
        );
      }
    });
  }
});

describe("requireMongo", () => {
  it("returns uri + db when both are present", () => {
    stubAll("present");
    expect(requireMongo(readServerEnv())).toEqual({
      uri: "present",
      db: "present",
    });
  });

  it("throws listing both keys when both are missing", () => {
    stubAllEmpty();
    try {
      requireMongo(readServerEnv());
      throw new Error("expected requireMongo to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvMissingError);
      expect((e as Error).message).toBe(
        "Missing required env vars: MONGODB_URI, MONGODB_DB"
      );
    }
  });

  it("lists only the missing key when one is present", () => {
    stubAll("present");
    vi.stubEnv("MONGODB_DB", "");
    try {
      requireMongo(readServerEnv());
      throw new Error("expected requireMongo to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvMissingError);
      expect((e as Error).message).toBe("Missing required env vars: MONGODB_DB");
    }
  });
});

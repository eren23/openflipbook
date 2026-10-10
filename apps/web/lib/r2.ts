import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readServerEnv, requireR2 } from "./env";
import { requireStoredImageRead } from "./stored-image-access";
import { r2ClientConfig } from "./r2-client-config";
export { r2ClientConfig, type R2ClientConfig } from "./r2-client-config";

let cachedClient: S3Client | null = null;

function r2Client(): { s3: S3Client; bucket: string; publicBaseUrl: string } {
  const env = readServerEnv();
  const r2 = requireR2(env);
  if (!cachedClient) {
    cachedClient = new S3Client(r2ClientConfig(r2));
  }
  return {
    s3: cachedClient,
    bucket: r2.bucket,
    publicBaseUrl: r2.publicBaseUrl.replace(/\/$/, ""),
  };
}

export interface UploadedObject {
  key: string;
  url: string;
  contentType: string;
}

export async function uploadJpeg(
  key: string,
  body: Buffer,
  contentType = "image/jpeg",
  signal?: AbortSignal
): Promise<UploadedObject> {
  const { s3, bucket, publicBaseUrl } = r2Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "private, no-store",
    }),
    signal ? { abortSignal: signal } : undefined
  );
  return { key, url: `${publicBaseUrl}/${key}`, contentType };
}

export function decodeDataUrl(dataUrl: string): {
  contentType: string;
  bytes: Buffer;
} {
  const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) throw new Error("not a base64 data URL");
  const contentType = match[1]!;
  const b64 = match[2]!;
  return { contentType, bytes: Buffer.from(b64, "base64") };
}

/** The storage key when `url` lives under our public base, else null.
 * Pure — the testable half of inlineStoredImage. */
export function storedKeyFromUrl(
  url: string,
  publicBaseUrl: string
): string | null {
  const base = publicBaseUrl.replace(/\/$/, "");
  if (!base) return null;
  let target = url;
  // Browsers expand same-origin /api/blobs URLs to absolute currentSrc values.
  // Access to the extracted key is authorized separately before any read.
  if (base.startsWith("/") && /^https?:\/\//.test(target)) {
    try { target = new URL(target).pathname; } catch { return null; }
  }
  if (!target.startsWith(`${base}/`)) return null;
  const key = target.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "";
  try { return key.length > 0 ? decodeURIComponent(key) : null; } catch { return null; }
}

/**
 * Read our authorized stored image as a data URL for provider conditioning.
 * Providers cannot fetch a private /api/blobs URL using the creator's cookie.
 * The server checks the caller's read access before reading the exact bytes.
 * Foreign URLs and failures return null for the caller's normal fallback.
 */
export async function inlineStoredImage(url: string): Promise<string | null> {
  try {
    const { s3, bucket, publicBaseUrl } = r2Client();
    const key = storedKeyFromUrl(url, publicBaseUrl);
    if (!key) return null;
    await requireStoredImageRead(key);
    const got = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!got.Body) return null;
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(got.ContentType || "image/jpeg")) return null;
    const contentType = got.ContentType || "image/jpeg";
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Raw stored bytes by key (the nodes collection stores image_key directly).
 * Best-effort: null on any failure. */
export async function getStoredBytes(
  key: string,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const { s3, bucket } = r2Client();
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), signal ? { abortSignal: signal } : undefined);
    if (!got.Body) return null;
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    if (bytes.length === 0) return null;
    return { bytes, contentType: got.ContentType || "image/jpeg" };
  } catch {
    return null;
  }
}

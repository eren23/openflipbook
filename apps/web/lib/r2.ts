import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readServerEnv, requireR2 } from "./env";

let cachedClient: S3Client | null = null;

export interface R2ClientConfig {
  region: "auto";
  endpoint: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

/**
 * S3Client config from resolved R2 settings. With no `endpoint` override we
 * derive Cloudflare R2's account-scoped URL and use virtual-host addressing
 * (today's behavior). With an explicit `endpoint` (e.g. a Minio container) we
 * use it verbatim and switch to path-style addressing, which Minio needs.
 * Pure so the endpoint/style decision is unit-tested without a live client.
 */
export function r2ClientConfig(r2: {
  accountId: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string | null;
}): R2ClientConfig {
  return {
    region: "auto",
    endpoint: r2.endpoint ?? `https://${r2.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(r2.endpoint),
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  };
}

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
  contentType = "image/jpeg"
): Promise<UploadedObject> {
  const { s3, bucket, publicBaseUrl } = r2Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
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
  if (!base || !url.startsWith(`${base}/`)) return null;
  const key = url.slice(base.length + 1).split(/[?#]/, 1)[0] ?? "";
  return key.length > 0 ? decodeURIComponent(key) : null;
}

/**
 * Inline one of OUR stored images into a data URL. Self-host reality check:
 * the docker stack's public base is a localhost minio URL — the browser can
 * load it, but OpenRouter/Google refuse to fetch private/localhost URLs, so
 * an unprefetched tap on a reopened node 400s at the VLM ("Cannot fetch
 * from private/localhost URLs"). The web server CAN reach the store (its S3
 * client speaks to the container endpoint), so the proxies inline the bytes
 * before forwarding. Best-effort: foreign URLs / fetch failures -> null and
 * the caller forwards the original URL (today's behaviour).
 */
export async function inlineStoredImage(url: string): Promise<string | null> {
  try {
    const { s3, bucket, publicBaseUrl } = r2Client();
    const key = storedKeyFromUrl(url, publicBaseUrl);
    if (!key) return null;
    const got = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!got.Body) return null;
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    if (bytes.length === 0) return null;
    const contentType = got.ContentType || "image/jpeg";
    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Raw stored bytes by key (the nodes collection stores image_key directly).
 * Best-effort: null on any failure. */
export async function getStoredBytes(
  key: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const { s3, bucket } = r2Client();
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!got.Body) return null;
    const bytes = Buffer.from(await got.Body.transformToByteArray());
    if (bytes.length === 0) return null;
    return { bytes, contentType: got.ContentType || "image/jpeg" };
  } catch {
    return null;
  }
}

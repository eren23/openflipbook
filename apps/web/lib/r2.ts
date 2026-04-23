import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readServerEnv, requireR2 } from "./env";

let cachedClient: S3Client | null = null;

function r2Client(): { s3: S3Client; bucket: string; publicBaseUrl: string } {
  const env = readServerEnv();
  const r2 = requireR2(env);
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2.accessKeyId,
        secretAccessKey: r2.secretAccessKey,
      },
    });
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

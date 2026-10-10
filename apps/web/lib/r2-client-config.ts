export interface R2ClientConfig {
  region: "auto";
  endpoint: string;
  forcePathStyle: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string };
}

/** Pure connection configuration shared by server and operator tools. */
export function r2ClientConfig(r2: {
  accountId: string | null; accessKeyId: string; secretAccessKey: string; endpoint: string | null;
}): R2ClientConfig {
  return {
    region: "auto",
    endpoint: r2.endpoint ?? `https://${r2.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(r2.endpoint),
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  };
}

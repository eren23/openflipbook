export interface ServerEnv {
  MODAL_API_URL: string | null;
  MONGODB_URI: string | null;
  MONGODB_DB: string | null;
  R2_ACCOUNT_ID: string | null;
  R2_ACCESS_KEY_ID: string | null;
  R2_SECRET_ACCESS_KEY: string | null;
  R2_BUCKET: string | null;
  R2_PUBLIC_BASE_URL: string | null;
  // Explicit S3 endpoint override. Set it to point at a self-hosted, S3-
  // compatible store (e.g. a local Minio container) instead of Cloudflare R2.
  // Unset = derive the Cloudflare endpoint from R2_ACCOUNT_ID (today's path).
  R2_ENDPOINT: string | null;
}

export function readServerEnv(): ServerEnv {
  return {
    MODAL_API_URL: process.env.MODAL_API_URL || null,
    MONGODB_URI: process.env.MONGODB_URI || null,
    MONGODB_DB: process.env.MONGODB_DB || null,
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || null,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || null,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || null,
    R2_BUCKET: process.env.R2_BUCKET || null,
    R2_PUBLIC_BASE_URL: process.env.R2_PUBLIC_BASE_URL || null,
    R2_ENDPOINT: process.env.R2_ENDPOINT || null,
  };
}

export class EnvMissingError extends Error {
  constructor(keys: string[]) {
    super(`Missing required env vars: ${keys.join(", ")}`);
    this.name = "EnvMissingError";
  }
}

export function requireR2(env: ServerEnv) {
  const missing: string[] = [];
  // With an explicit endpoint (Minio etc.) the account-id-derived Cloudflare
  // URL is unused, so the account id is optional; otherwise it's required.
  if (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) missing.push("R2_ACCOUNT_ID");
  if (!env.R2_ACCESS_KEY_ID) missing.push("R2_ACCESS_KEY_ID");
  if (!env.R2_SECRET_ACCESS_KEY) missing.push("R2_SECRET_ACCESS_KEY");
  if (!env.R2_BUCKET) missing.push("R2_BUCKET");
  if (!env.R2_PUBLIC_BASE_URL) missing.push("R2_PUBLIC_BASE_URL");
  if (missing.length) throw new EnvMissingError(missing);
  return {
    accountId: env.R2_ACCOUNT_ID, // may be null when an endpoint is set
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
    publicBaseUrl: env.R2_PUBLIC_BASE_URL!,
    endpoint: env.R2_ENDPOINT, // null = derive from accountId
  };
}

export function requireMongo(env: ServerEnv) {
  const missing: string[] = [];
  if (!env.MONGODB_URI) missing.push("MONGODB_URI");
  if (!env.MONGODB_DB) missing.push("MONGODB_DB");
  if (missing.length) throw new EnvMissingError(missing);
  return { uri: env.MONGODB_URI!, db: env.MONGODB_DB! };
}

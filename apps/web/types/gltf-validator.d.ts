declare module "gltf-validator" {
  export function version(): string;
  export function validateBytes(bytes: Uint8Array, options?: { format?: "glb"; maxIssues?: number; writeTimestamp?: boolean }): Promise<{
    issues: { numErrors: number; numWarnings: number; truncated?: boolean; messages: { code: string; message: string; severity: number; pointer?: string }[] };
  }>;
}

// Join a Modal backend base URL with a request path. Every /api route that
// proxies upstream built `${base.replace(/\/$/, "")}${path}` inline — same
// trailing-slash strip, repeated ~9 times and easy to get subtly wrong (a
// double slash, or a missing one). `path` must start with "/".
export const modalUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/, "")}${path}`;

// Optional shared-token auth (Wave 5): when SHARED_TOKEN is set on BOTH the
// web server and the backend, every server-side proxy hop carries it and the
// backend's middleware refuses requests without it. The browser never holds
// the token — only these Node-side fetches do. Unset (the default) -> {}
// and the backend stays open: byte-identical self-host behaviour.
export const SHARED_TOKEN_HEADER = "x-openflipbook-token";

export function modalAuthHeaders(): Record<string, string> {
  const token = process.env.SHARED_TOKEN;
  return token ? { [SHARED_TOKEN_HEADER]: token } : {};
}

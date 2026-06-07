// Join a Modal backend base URL with a request path. Every /api route that
// proxies upstream built `${base.replace(/\/$/, "")}${path}` inline — same
// trailing-slash strip, repeated ~9 times and easy to get subtly wrong (a
// double slash, or a missing one). `path` must start with "/".
export const modalUrl = (base: string, path: string): string =>
  `${base.replace(/\/$/, "")}${path}`;

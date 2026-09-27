export function placeScenesEnabled() {
  return process.env.NEXT_PUBLIC_WORLD_SCENES === "1" || (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_WORLD_SCENES !== "0");
}

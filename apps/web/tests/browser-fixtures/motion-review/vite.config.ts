import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { motionPlaybackResponse } from "../../../lib/motion-playback";
const here = dirname(fileURLToPath(import.meta.url)), run = promisify(execFile);
export default defineConfig({
  root: here, resolve: { alias: { "@": resolve(here, "../../..") } }, esbuild: { jsx: "automatic" },
  define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) },
  server: { host: "127.0.0.1", port: 3006, strictPort: true },
  plugins: [{ name: "synthetic-private-media", async configureServer(server) {
    const directory = await mkdtemp(join(tmpdir(), "ofb-review-browser-")), video = join(directory, "fixture.mp4");
    try {
      await run("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=24", "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", video]);
      const bytes = await readFile(video), frames: Buffer[] = [];
      for (let i = 0; i < 5; i++) {
        const path = join(directory, `frame-${i}.png`);
        await run("ffmpeg", ["-nostdin", "-v", "error", "-i", video, "-ss", String(Math.min(i * 1.5, 5.95)), "-frames:v", "1", path]);
        frames.push(await readFile(path));
      }
      server.middlewares.use((req, res, next) => {
        const frame = /^\/api\/world\/world\/motion-studies\/study\/([0-4])\/render$/.exec(req.url ?? "");
        const clip = req.url === "/api/world/world/motion-studies/study/videos/clip";
        if (!frame && !clip) return next();
        if (clip) {
          const result = motionPlaybackResponse(new Request("http://127.0.0.1:3006/clip", { headers: req.headers.range ? { range: req.headers.range } : {} }), bytes);
          res.statusCode = result.status; result.headers.forEach((value, key) => res.setHeader(key, value));
          void result.arrayBuffer().then(body => res.end(Buffer.from(body)), next); return;
        }
        const body = clip ? bytes : frames[Number(frame![1])]!;
        res.setHeader("Cache-Control", "no-store"); res.setHeader("Content-Type", clip ? "video/mp4" : "image/png");
        res.setHeader("Content-Length", body.length); res.end(body);
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  } }],
});

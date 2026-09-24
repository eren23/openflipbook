/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  reactStrictMode: true,
  // Nothing renders next/image, but /_next/image still answered and ran
  // sharp (libvips CVEs; the unauthenticated RCE fixed in #277 lived here).
  // Unoptimized, the route is a 404 before sharp loads.
  images: { unoptimized: true },
  transpilePackages: ["@openflipbook/config"],
  typedRoutes: true,
  async headers() {
    return [
      {
        // The embed surface is MADE to be framed (publish-gated server-side);
        // declare it explicitly so a future global anti-framing header can't
        // silently kill every embed in the wild.
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
        ],
      },
    ];
  },
};

export default nextConfig;

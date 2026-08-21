/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  reactStrictMode: true,
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

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: new URL("../..", import.meta.url).pathname,
  reactStrictMode: true,
  transpilePackages: ["@openflipbook/config"],
  typedRoutes: true,
};

export default nextConfig;

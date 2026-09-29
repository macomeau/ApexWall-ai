const path = require("path");

// STATIC_EXPORT=1 -> `next build` produces a static `out/` directory for the
// Neon Functions deployment (see neon/deploy.sh). Without it, `next build`
// behaves normally (Node server / Vercel).
const isStaticExport = process.env.STATIC_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  ...(isStaticExport ? { output: "export", images: { unoptimized: true } } : {}),
  webpack: (config) => {
    config.resolve.alias["@"] = path.resolve(__dirname, "src");
    return config;
  },
};

module.exports = nextConfig;

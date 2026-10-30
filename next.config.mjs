/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    'bullmq',
    'ioredis',
    'mysql2',
    'nodemailer',
    'node-cron',
    'socket.io',
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'node:sqlite': 'commonjs node:sqlite',
      });
    }
    return config;
  },
};

export default nextConfig;


import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');
// NOTE: rewrites are resolved at BUILD time. In Docker, API_INTERNAL_URL is passed as a build arg.
const api = process.env.API_INTERNAL_URL || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { outputFileTracingRoot: root },
  async rewrites() {
    // Browser talks only to the web origin; cookies stay same-origin. API keys never reach the browser.
    return [{ source: '/api/:path*', destination: `${api}/api/:path*` }];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Node-only packages: BullMQ and ioredis open sockets, sharp and
  // @napi-rs/canvas load native binaries, and pdf.js ships its own ESM
  // worker. Keep all of them out of the bundler's dependency graph so
  // Route Handlers require them at runtime instead.
  //
  // pino belongs here for the same reason and one more: its pretty transport
  // runs in a worker thread that thread-stream spawns by resolving
  // `pino/lib/worker.js` *relative to wherever pino was loaded from*. Bundled
  // into `.next/server/vendor-chunks/`, that resolves to a path which does
  // not exist, the worker throws MODULE_NOT_FOUND, and because the throw
  // happens on the worker's own tick it takes the whole server process down
  // rather than failing the one request.
  serverExternalPackages: [
    'bullmq',
    'ioredis',
    'sharp',
    '@napi-rs/canvas',
    'pdfjs-dist',
    'pino',
    'pino-pretty',
    'thread-stream',
  ],
};

export default nextConfig;

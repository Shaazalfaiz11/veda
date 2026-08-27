import { NextResponse, type NextRequest } from 'next/server';

/**
 * Cross-origin access to the API.
 *
 * Only needed when the pages and the API are deployed separately — the UI on
 * one host, the worker-backed API on another. Served as a single deployment
 * the requests are same-origin and none of this applies, which is why the
 * allowlist is empty by default: a deployment that does not need CORS does not
 * silently get it.
 *
 * `CORS_ALLOWED_ORIGINS` is a comma-separated list of exact origins, e.g.
 * `https://veda.vercel.app`. Exact origins rather than a wildcard: the API
 * accepts uploads and returns a student's work, and `*` would let any page on
 * the internet drive it.
 */

function allowedOrigins(): string[] {
  return (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(origin: string | null): Headers | null {
  const headers = new Headers();
  const allowed = allowedOrigins();

  if (!origin || allowed.length === 0) return null;
  if (!allowed.includes(origin)) return null;

  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  headers.set('access-control-allow-headers', 'content-type,accept');
  headers.set('access-control-max-age', '86400');
  // The allowed origin depends on the request's own Origin, so a cache must
  // not serve one origin's response to another.
  headers.set('vary', 'Origin');

  return headers;
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  // Preflight is answered here; it never reaches the route.
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: headers ? 204 : 403, headers: headers ?? undefined });
  }

  const response = NextResponse.next();

  if (headers) {
    headers.forEach((value, key) => response.headers.set(key, value));
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};

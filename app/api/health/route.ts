import { NextResponse } from 'next/server';
import { getRedisConnection, pingRedis } from '@/lib/queue/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health — reports whether the API can reach Redis. */
export async function GET() {
  const redisReachable = await pingRedis(getRedisConnection());

  return NextResponse.json(
    {
      status: redisReachable ? 'ok' : 'degraded',
      redis: redisReachable ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    },
    { status: redisReachable ? 200 : 503 },
  );
}

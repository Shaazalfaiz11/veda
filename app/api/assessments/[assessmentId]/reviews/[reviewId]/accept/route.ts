import { reviewActionHandler } from '@/lib/services/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/assessments/:assessmentId/reviews/:reviewId/accept */
export const POST = reviewActionHandler('ACCEPT');

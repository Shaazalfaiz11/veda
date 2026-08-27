import { reviewActionHandler } from '@/lib/services/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/assessments/:assessmentId/reviews/:reviewId/skip */
export const POST = reviewActionHandler('SKIP');

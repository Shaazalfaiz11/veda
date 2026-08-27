import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueAssessmentProcessing = vi.fn();

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: (...args: unknown[]) => enqueueAssessmentProcessing(...args),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { POST: createRoute } = await import('@/app/api/assessments/route');
const { GET: getRoute } = await import('@/app/api/assessments/[assessmentId]/route');
const { POST: processRoute } = await import('@/app/api/assessments/[assessmentId]/process/route');
const { GET: statusRoute } = await import('@/app/api/assessments/[assessmentId]/status/route');

const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { markProcessing } = await import('@/lib/services/assessment-service');

const store = new InMemoryAssessmentStore();
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';

function postRequest(body: unknown, raw?: string) {
  return new Request('http://localhost/api/assessments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

async function createViaApi(body: unknown = {}) {
  const response = await createRoute(postRequest(body));
  return (await response.json()) as { assessmentId: string };
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
  enqueueAssessmentProcessing.mockReset();
  enqueueAssessmentProcessing.mockResolvedValue({ id: 'job' });
});

describe('POST /api/assessments', () => {
  it('returns 201 with the created assessment', async () => {
    const response = await createRoute(postRequest({ title: 'Unit test 3' }));
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.status).toBe('CREATED');
    expect(body.title).toBe('Unit test 3');
    expect(body.assessmentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('starts an assessment with no documents', async () => {
    const response = await createRoute(postRequest({}));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.documents).toEqual([]);
  });

  it('returns 400 with field detail for an invalid body', async () => {
    const response = await createRoute(postRequest({ title: '' }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it('returns 400 for malformed JSON rather than throwing', async () => {
    const response = await createRoute(postRequest(null, '{ not json'));
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/assessments/:assessmentId/process', () => {
  it('returns 202 with the queue ticket', async () => {
    const { assessmentId } = await createViaApi();
    const response = await processRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(response.status).toBe(202);

    const body = await response.json();
    expect(body).toEqual({
      assessmentId,
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'QUEUED',
    });
  });

  it('creates exactly one queue job', async () => {
    const { assessmentId } = await createViaApi();
    await processRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(enqueueAssessmentProcessing).toHaveBeenCalledTimes(1);
    expect(enqueueAssessmentProcessing).toHaveBeenCalledWith({
      assessmentId,
      jobId: expect.any(String),
    });
  });

  it('does not process synchronously — the response beats the work', async () => {
    const { assessmentId } = await createViaApi();

    let enqueueResolved = false;
    enqueueAssessmentProcessing.mockImplementation(async () => {
      enqueueResolved = true;
      return { id: 'job' };
    });

    const response = await processRoute(new Request('http://localhost'), ctx(assessmentId));
    const body = await response.json();

    // The handler enqueues and returns; it never advances a stage itself.
    expect(enqueueResolved).toBe(true);
    expect(body.status).toBe('QUEUED');
    expect(body).not.toHaveProperty('questions');
    expect(body).not.toHaveProperty('grades');
  });

  it('returns 409 when the assessment is already queued', async () => {
    const { assessmentId } = await createViaApi();
    await processRoute(new Request('http://localhost'), ctx(assessmentId));

    const response = await processRoute(new Request('http://localhost'), ctx(assessmentId));
    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.error.code).toBe('CONFLICT');
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await processRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);
    expect(enqueueAssessmentProcessing).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await processRoute(new Request('http://localhost'), ctx('not-a-uuid'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/assessments/:assessmentId/status', () => {
  it('returns the documented status shape', async () => {
    const { assessmentId } = await createViaApi();
    await processRoute(new Request('http://localhost'), ctx(assessmentId));
    await markProcessing(assessmentId, 'EXTRACTING_ANSWERS');

    const response = await statusRoute(new Request('http://localhost'), ctx(assessmentId));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      assessmentId,
      status: 'PROCESSING',
      stage: 'EXTRACTING_ANSWERS',
      progress: 33,
    });
  });

  it('reports a freshly created assessment as CREATED at zero progress', async () => {
    const { assessmentId } = await createViaApi();
    const response = await statusRoute(new Request('http://localhost'), ctx(assessmentId));

    const body = await response.json();
    expect(body).toMatchObject({ status: 'CREATED', stage: null, progress: 0 });
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await statusRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await statusRoute(new Request('http://localhost'), ctx('../../etc/passwd'));
    expect(response.status).toBe(400);
  });
});

describe('GET /api/assessments/:assessmentId', () => {
  it('returns the full record including completed stages', async () => {
    const { assessmentId } = await createViaApi({ title: 'Full record' });
    const response = await getRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ assessmentId, title: 'Full record', status: 'CREATED' });
    expect(body.completedStages).toEqual([]);
    expect(body.documents).toEqual([]);
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await getRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);
  });
});

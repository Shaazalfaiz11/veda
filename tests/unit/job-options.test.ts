import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_JOB_NAME,
  AssessmentJobDataSchema,
  JOB_NAMES,
  JOB_SEQUENCE,
  JOB_STAGE,
  buildJobOptions,
} from '@/lib/queue/jobs';
import { PROCESSING_STAGES } from '@/lib/domain/assessment';

const SAMPLE_UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('job retry configuration', () => {
  it('uses exponential backoff with the configured attempt budget', () => {
    const options = buildJobOptions();
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 50 });
  });

  it('bounds retained job history so the queue cannot grow without limit', () => {
    const options = buildJobOptions();
    expect(options.removeOnComplete).toEqual({ age: 3600, count: 100 });
    expect(options.removeOnFail).toEqual({ age: 86_400, count: 500 });
  });

  it('lets a caller set the job id without losing the retry policy', () => {
    const options = buildJobOptions({ jobId: 'fixed-id' });
    expect(options.jobId).toBe('fixed-id');
    expect(options.attempts).toBe(3);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 50 });
  });
});

describe('job and stage wiring', () => {
  it('maps every job name onto a processing stage, in pipeline order', () => {
    expect(Object.values(JOB_STAGE)).toEqual([...PROCESSING_STAGES]);
    expect(Object.keys(JOB_STAGE)).toHaveLength(Object.keys(JOB_NAMES).length);
  });

  it('enters the pipeline at PREPARE and ends at FINALIZE', () => {
    expect(ASSESSMENT_JOB_NAME).toBe(JOB_NAMES.PREPARE);
    expect(JOB_SEQUENCE[0]).toBe(JOB_NAMES.PREPARE);
    expect(JOB_SEQUENCE.at(-1)).toBe(JOB_NAMES.FINALIZE);
    expect(JOB_SEQUENCE).toHaveLength(PROCESSING_STAGES.length);
  });
});

describe('job payload validation', () => {
  it('accepts a well-formed payload', () => {
    const result = AssessmentJobDataSchema.safeParse({
      assessmentId: SAMPLE_UUID,
      jobId: 'job-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID assessment id', () => {
    const result = AssessmentJobDataSchema.safeParse({ assessmentId: 'nope', jobId: 'job-1' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty job id', () => {
    const result = AssessmentJobDataSchema.safeParse({ assessmentId: SAMPLE_UUID, jobId: '' });
    expect(result.success).toBe(false);
  });
});

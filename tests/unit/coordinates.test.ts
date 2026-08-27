import { describe, expect, it } from 'vitest';
import {
  NormalizedRectSchema,
  PageRegionSchema,
  isNormalizedRect,
  toNormalizedRect,
  toPixelRect,
  unionRects,
} from '@/lib/domain/document';

const VALID = { x: 0.12, y: 0.44, width: 0.76, height: 0.09 };

describe('normalized coordinate validation', () => {
  it('accepts the documented example', () => {
    expect(NormalizedRectSchema.safeParse(VALID).success).toBe(true);
    expect(isNormalizedRect(VALID)).toBe(true);
  });

  it('accepts a rect covering the whole page', () => {
    expect(isNormalizedRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it('rejects negative coordinates', () => {
    expect(isNormalizedRect({ ...VALID, x: -0.01 })).toBe(false);
    expect(isNormalizedRect({ ...VALID, y: -1 })).toBe(false);
  });

  it('rejects values above 1 — pixel coordinates are not the source of truth', () => {
    expect(isNormalizedRect({ x: 120, y: 440, width: 760, height: 90 })).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(isNormalizedRect({ ...VALID, x: Number.NaN })).toBe(false);
    expect(isNormalizedRect({ ...VALID, width: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it('rejects a rect that runs past the right edge', () => {
    const result = NormalizedRectSchema.safeParse({ x: 0.8, y: 0.1, width: 0.4, height: 0.1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/right edge/);
    }
  });

  it('rejects a rect that runs past the bottom edge', () => {
    const result = NormalizedRectSchema.safeParse({ x: 0.1, y: 0.95, width: 0.1, height: 0.2 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/bottom edge/);
    }
  });

  it('tolerates floating-point drift at the edge', () => {
    expect(isNormalizedRect({ x: 0.1, y: 0.1, width: 0.9, height: 0.9 })).toBe(true);
  });

  it('rejects missing fields', () => {
    expect(isNormalizedRect({ x: 0.1, y: 0.1 })).toBe(false);
  });
});

describe('page regions', () => {
  it('accepts a 1-based page number', () => {
    expect(PageRegionSchema.safeParse({ ...VALID, pageNumber: 2 }).success).toBe(true);
  });

  it('rejects page zero — page numbering is 1-based', () => {
    expect(PageRegionSchema.safeParse({ ...VALID, pageNumber: 0 }).success).toBe(false);
  });

  it('rejects a fractional page number', () => {
    expect(PageRegionSchema.safeParse({ ...VALID, pageNumber: 1.5 }).success).toBe(false);
  });
});

describe('pixel conversion', () => {
  const page = { width: 800, height: 1000 };

  it('normalizes a pixel rect against its page, top-left origin', () => {
    expect(toNormalizedRect({ x: 80, y: 250, width: 400, height: 100 }, page)).toEqual({
      x: 0.1,
      y: 0.25,
      width: 0.5,
      height: 0.1,
    });
  });

  it('round-trips through pixels without drift', () => {
    const pixels = { x: 96, y: 440, width: 608, height: 90 };
    const normalized = toNormalizedRect(pixels, page);
    const back = toPixelRect(normalized, page);

    expect(back.x).toBeCloseTo(pixels.x, 6);
    expect(back.y).toBeCloseTo(pixels.y, 6);
    expect(back.width).toBeCloseTo(pixels.width, 6);
    expect(back.height).toBeCloseTo(pixels.height, 6);
  });

  it('projects the same rect correctly onto any display size', () => {
    // This is the whole point of normalizing: one stored rect, many surfaces.
    const rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

    expect(toPixelRect(rect, { width: 400, height: 500 })).toEqual({
      x: 100,
      y: 250,
      width: 200,
      height: 125,
    });
    expect(toPixelRect(rect, { width: 1600, height: 2000 })).toEqual({
      x: 400,
      y: 1000,
      width: 800,
      height: 500,
    });
  });

  it('clamps a pixel rect that overflows its page', () => {
    const normalized = toNormalizedRect({ x: 0, y: 0, width: 1200, height: 2000 }, page);
    expect(normalized.width).toBe(1);
    expect(normalized.height).toBe(1);
  });

  it('refuses to normalize against a zero-sized page', () => {
    expect(() => toNormalizedRect({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 10 }))
      .toThrow(/positive/);
  });
});

describe('rect union', () => {
  it('returns null for an empty set', () => {
    expect(unionRects([])).toBeNull();
  });

  it('returns the same rect for a single member', () => {
    const union = unionRects([VALID]);
    expect(union?.x).toBeCloseTo(VALID.x, 9);
    expect(union?.y).toBeCloseTo(VALID.y, 9);
    expect(union?.width).toBeCloseTo(VALID.width, 9);
    expect(union?.height).toBeCloseTo(VALID.height, 9);
  });

  it('bounds a stack of line rects — the coarse region for scroll-into-view', () => {
    const lines = [
      { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
      { x: 0.12, y: 0.25, width: 0.7, height: 0.04 },
      { x: 0.1, y: 0.3, width: 0.5, height: 0.04 },
    ];

    const union = unionRects(lines);
    expect(union?.x).toBeCloseTo(0.1, 6);
    expect(union?.y).toBeCloseTo(0.2, 6);
    expect(union?.width).toBeCloseTo(0.72, 6);
    expect(union?.height).toBeCloseTo(0.14, 6);
  });

  it('produces a union that is itself a valid normalized rect', () => {
    const union = unionRects([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    ]);

    expect(isNormalizedRect(union!)).toBe(true);
  });
});

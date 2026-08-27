import { z } from 'zod';

/**
 * Coordinate convention.
 * ----------------------
 * Every region in this system — question bounds, answer-block line rects,
 * highlight overlays — is expressed in **normalized coordinates** measured
 * against the prepared page bitmap.
 *
 *   origin  (0, 0)  = top-left of the prepared page
 *   extent  (1, 1)  = bottom-right of the prepared page
 *
 *   x      horizontal offset of the left edge,  0..1
 *   y      vertical   offset of the top  edge,  0..1
 *   width  fraction of page width,              0..1
 *   height fraction of page height,             0..1
 *
 * Y increases downward, matching image and DOM conventions rather than PDF
 * user space (which is bottom-left origin). Preparation resolves that
 * difference once, so nothing downstream has to think about it.
 *
 * Pixel coordinates are never the source of truth. A normalized rect is
 * resolution independent: the same values are correct at any zoom level,
 * any container width, and any prepared-page scale — which is precisely why
 * resizing a page during preparation cannot invalidate stored regions.
 *
 * Example, a wide band a little under halfway down page 2:
 *
 *   { pageNumber: 2, x: 0.12, y: 0.44, width: 0.76, height: 0.09 }
 */

/** A rectangle on a prepared page, normalized to 0..1 with a top-left origin. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle bound to a specific page of a document. */
export interface PageRegion extends NormalizedRect {
  pageNumber: number;
}

/** Tolerance for floating-point drift when checking edge containment. */
const EPSILON = 1e-6;

// .finite() keeps this a ZodNumber, so the chain stays typed and NaN /
// Infinity are rejected rather than silently passing the range checks.
const unitInterval = z
  .number()
  .finite({ message: 'must be a finite number' })
  .min(0, { message: 'must be at least 0' })
  .max(1, { message: 'must be at most 1' });

export const NormalizedRectSchema = z
  .object({
    x: unitInterval,
    y: unitInterval,
    width: unitInterval,
    height: unitInterval,
  })
  .superRefine((rect, ctx) => {
    // A rect that starts inside the page but extends past its edge is a
    // coordinate-space bug, not a clipping request — reject it loudly.
    if (rect.x + rect.width > 1 + EPSILON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['width'],
        message: 'x + width must not exceed 1 (rect extends past the right edge).',
      });
    }
    if (rect.y + rect.height > 1 + EPSILON) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['height'],
        message: 'y + height must not exceed 1 (rect extends past the bottom edge).',
      });
    }
  });

export const PageRegionSchema = z.intersection(
  NormalizedRectSchema,
  z.object({ pageNumber: z.number().int().positive() }),
);

export function isNormalizedRect(value: unknown): value is NormalizedRect {
  return NormalizedRectSchema.safeParse(value).success;
}

/**
 * Converts a pixel-space rect measured on a prepared page into normalized
 * coordinates. This is the only sanctioned direction of travel at ingest
 * time: pixels in, normalized out, stored normalized.
 */
export function toNormalizedRect(
  pixels: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): NormalizedRect {
  if (page.width <= 0 || page.height <= 0) {
    throw new Error('Page dimensions must be positive to normalize a rect.');
  }

  return {
    x: clampUnit(pixels.x / page.width),
    y: clampUnit(pixels.y / page.height),
    width: clampUnit(pixels.width / page.width),
    height: clampUnit(pixels.height / page.height),
  };
}

/**
 * Projects a normalized rect back onto a concrete pixel surface — the
 * prepared bitmap, or a scaled rendering of it in the browser. Because the
 * stored form is normalized, the same rect projects correctly onto any size.
 */
export function toPixelRect(
  rect: NormalizedRect,
  surface: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.x * surface.width,
    y: rect.y * surface.height,
    width: rect.width * surface.width,
    height: rect.height * surface.height,
  };
}

/** The smallest rect containing all of the given rects. */
export function unionRects(rects: readonly NormalizedRect[]): NormalizedRect | null {
  if (rects.length === 0) return null;

  let left = 1;
  let top = 1;
  let right = 0;
  let bottom = 0;

  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }

  return {
    x: clampUnit(left),
    y: clampUnit(top),
    width: clampUnit(right - left),
    height: clampUnit(bottom - top),
  };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

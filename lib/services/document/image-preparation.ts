import sharp from 'sharp';
import { InvalidDocumentError } from '@/lib/errors';
import type { RenderedPage } from './pdf-preparation';

/**
 * Image preparation.
 *
 * A PNG or JPEG upload is a one-page document. It is normalised into exactly
 * the same prepared-page shape a PDF page produces, so nothing downstream
 * needs to know which kind of file arrived.
 *
 * Two transformations are applied, both deliberate:
 *
 *  - EXIF orientation is baked in. A sheet photographed on a phone commonly
 *    carries an orientation flag rather than rotated pixels; without this the
 *    recorded dimensions describe the stored bytes while the teacher sees the
 *    rotated image, and every coordinate would be measured against the wrong
 *    axes.
 *  - Oversized scans are fitted to the max-dimension box, never enlarged.
 */
export async function prepareImage(data: Buffer, maxDimension: number): Promise<RenderedPage> {
  let sourceWidth: number;
  let sourceHeight: number;
  let rotation = 0;

  try {
    const metadata = await sharp(data).metadata();

    if (!metadata.width || !metadata.height) {
      throw new InvalidDocumentError('The image has no readable dimensions.');
    }

    // Orientation values 5-8 swap the axes on display.
    const orientation = metadata.orientation ?? 1;
    const swapsAxes = orientation >= 5 && orientation <= 8;

    sourceWidth = swapsAxes ? metadata.height : metadata.width;
    sourceHeight = swapsAxes ? metadata.width : metadata.height;
    rotation = orientationToDegrees(orientation);
  } catch (error) {
    if (error instanceof InvalidDocumentError) throw error;
    throw new InvalidDocumentError('The image could not be read.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  try {
    const pipeline = sharp(data)
      // No arguments: apply whatever the EXIF orientation says.
      .rotate()
      .resize(targetWidth, targetHeight, { fit: 'fill', withoutEnlargement: true })
      // Flatten onto white so a transparent PNG does not prepare as black.
      .flatten({ background: '#ffffff' })
      .png();

    const output = await pipeline.toBuffer({ resolveWithObject: true });

    return {
      pageNumber: 1,
      data: output.data,
      width: output.info.width,
      height: output.info.height,
      scale,
      sourceWidth,
      sourceHeight,
      rotation,
    };
  } catch (error) {
    throw new InvalidDocumentError('The image could not be prepared.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** Degrees of rotation implied by an EXIF orientation tag. */
function orientationToDegrees(orientation: number): number {
  switch (orientation) {
    case 3:
    case 4:
      return 180;
    case 5:
    case 6:
      return 90;
    case 7:
    case 8:
      return 270;
    default:
      return 0;
  }
}

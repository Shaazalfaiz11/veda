/**
 * The small control glyphs used by the mapping screen.
 *
 * The chevron is the exact path Figma exports for the Simple Design System
 * chevron: `M10.8 5.8 L5.8 0.8 L0.8 5.8` in an 11.6 x 6.6 box, 1.6 stroke,
 * round caps and joins.
 *
 * The glyph keeps that true size inside whatever box it is given rather than
 * being scaled to fill it — which matters, because the design uses the same
 * glyph in a 16px box on a question card and a 24px box in the viewer
 * toolbar, and scaling it would make the toolbar chevrons visibly heavier.
 *
 * `Minus` and `Plus` could not be exported — the Figma MCP call budget ran
 * out — so they are drawn at the chevron's width, stroke weight and caps.
 * They are the only two glyphs on this screen not taken from an export.
 */

type Direction = 'up' | 'down' | 'left' | 'right';

const ROTATION: Record<Direction, number> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};

/** True glyph dimensions, from the export. */
const GLYPH_WIDTH = 11.6;
const GLYPH_HEIGHT = 6.6;
const STROKE = 1.6;

interface GlyphProps {
  size?: number;
  className?: string;
}

function frame(size: number) {
  return {
    viewBox: `0 0 ${size} ${size}`,
    ox: (size - GLYPH_WIDTH) / 2,
    oy: (size - GLYPH_HEIGHT) / 2,
  };
}

export function Chevron({
  direction = 'down',
  size = 16,
  className,
}: GlyphProps & { direction?: Direction }) {
  const { viewBox, ox, oy } = frame(size);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      aria-hidden="true"
      style={{ transform: `rotate(${ROTATION[direction]}deg)`, flexShrink: 0 }}
    >
      <path
        d={`M${ox + 10.8} ${oy + 5.8}L${ox + 5.8} ${oy + 0.8}L${ox + 0.8} ${oy + 5.8}`}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Minus({ size = 16, className }: GlyphProps) {
  const half = size / 2;
  const inset = (size - GLYPH_WIDTH) / 2;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d={`M${inset} ${half}h${GLYPH_WIDTH}`}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Plus({ size = 16, className }: GlyphProps) {
  const half = size / 2;
  const inset = (size - GLYPH_WIDTH) / 2;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        d={`M${half} ${inset}v${GLYPH_WIDTH}M${inset} ${half}h${GLYPH_WIDTH}`}
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

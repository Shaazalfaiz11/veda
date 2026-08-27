'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pageImageUrl } from '@/lib/api-client/client';
import type { Answer, DocumentWithPages, Question } from '@/lib/api-client/types';
import { Chevron, Minus, Plus } from '@/components/ui/Icon';
import styles from './PageViewer.module.css';

/**
 * The answer sheet viewer (Figma `1:9017`).
 *
 * Answer regions arrive as normalized rectangles — origin top-left, both axes
 * in [0,1]. They are turned into CSS percentages of the page stage, never
 * into stored pixels. That is the whole reason the coordinates are normalized
 * upstream: the same rect is correct at 60% zoom, at 200%, in a resized
 * window and on a phone, because the browser resolves the percentage against
 * whatever the bitmap is currently rendered at.
 *
 * An answer that runs onto the next page has one region per page, so a
 * continuation is drawn on the page it actually appears on rather than being
 * clipped to the first.
 */

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;
const DEFAULT_ZOOM_INDEX = 2;

export interface PageViewerProps {
  assessmentId: string;
  document: DocumentWithPages | null;
  answers: Answer[];
  questions: Question[];
  /** answerId -> effective questionId, from the mapping API. */
  effectiveByAnswerId: Map<string, string | null>;
  /** Highlights one answer and dims the rest. */
  focusedAnswerId: string | null;
}

export function PageViewer({
  assessmentId,
  document,
  answers,
  questions,
  effectiveByAnswerId,
  focusedAnswerId,
}: PageViewerProps) {
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [page, setPage] = useState(1);
  const pagesRef = useRef<HTMLDivElement>(null);

  const zoom = ZOOM_STEPS[zoomIndex]!;
  const pageCount = document?.pages.length ?? 0;

  const questionLabel = useMemo(() => {
    const byId = new Map(questions.map((q) => [q.id, q.labelRaw]));
    return byId;
  }, [questions]);

  /** Regions grouped by the page they lie on. */
  const regionsByPage = useMemo(() => {
    const grouped = new Map<
      number,
      Array<{ answerId: string; label: string | null; region: Answer['regions'][number] }>
    >();

    for (const answer of answers) {
      const questionId = effectiveByAnswerId.get(answer.id) ?? null;
      const label = questionId ? questionLabel.get(questionId) ?? null : null;

      for (const region of answer.regions) {
        const list = grouped.get(region.pageNumber) ?? [];
        list.push({ answerId: answer.id, label, region });
        grouped.set(region.pageNumber, list);
      }
    }

    return grouped;
  }, [answers, effectiveByAnswerId, questionLabel]);

  const scrollToPage = useCallback((next: number) => {
    setPage(next);
    const stage = pagesRef.current?.querySelector<HTMLElement>(`[data-page="${next}"]`);
    stage?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  /** First page the focused answer actually appears on. */
  const focusedPage = useMemo(() => {
    if (focusedAnswerId === null) return null;

    const answer = answers.find((entry) => entry.id === focusedAnswerId);
    if (!answer || answer.regions.length === 0) return null;

    return Math.min(...answer.regions.map((region) => region.pageNumber));
  }, [focusedAnswerId, answers]);

  /*
   * Clicking a question has to bring its answer into view, not merely dim the
   * others. An answer four pages down was highlighted correctly and still
   * invisible, because the viewer stayed wherever it was. An answer running
   * across a page break opens at the page it starts on.
   */
  useEffect(() => {
    if (focusedPage === null) return;
    scrollToPage(focusedPage);
  }, [focusedPage, scrollToPage]);

  if (!document || pageCount === 0) {
    return (
      <div className={styles.viewer}>
        <Header
          zoom={zoom}
          page={page}
          pageCount={0}
          onZoomIn={() => undefined}
          onZoomOut={() => undefined}
          onPrev={() => undefined}
          onNext={() => undefined}
        />
        <div className={styles.pages}>
          <p className={styles.empty}>
            The answer sheet has not been prepared yet, so there are no pages to show.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.viewer}>
      <Header
        zoom={zoom}
        page={page}
        pageCount={pageCount}
        onZoomIn={() => setZoomIndex((i) => Math.min(i + 1, ZOOM_STEPS.length - 1))}
        onZoomOut={() => setZoomIndex((i) => Math.max(i - 1, 0))}
        onPrev={() => scrollToPage(Math.max(1, page - 1))}
        onNext={() => scrollToPage(Math.min(pageCount, page + 1))}
      />

      <div className={styles.pages} ref={pagesRef}>
        {document.pages.map((meta) => (
          <div
            key={meta.pageNumber}
            className={styles.page}
            data-page={meta.pageNumber}
            style={{
              // Zoom scales the stage; the overlays follow because they are
              // sized as a percentage of it.
              width: `${zoom}%`,
              aspectRatio: `${meta.width} / ${meta.height}`,
            }}
          >
            {/* Plain <img>: the bitmap is served by an API route behind a
                dynamic path, and next/image would proxy it through the
                optimiser for no benefit. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.pageImage}
              src={pageImageUrl(assessmentId, document.id, meta.pageNumber)}
              alt={`Answer sheet page ${meta.pageNumber}`}
              width={meta.width}
              height={meta.height}
              loading={meta.pageNumber === 1 ? 'eager' : 'lazy'}
            />

            {(regionsByPage.get(meta.pageNumber) ?? []).map(({ answerId, label, region }, i) => {
              const dimmed = focusedAnswerId !== null && focusedAnswerId !== answerId;

              return (
                <div
                  key={`${answerId}-${i}`}
                  className={[
                    styles.overlay,
                    dimmed ? styles.overlayDim : '',
                    focusedAnswerId === answerId ? styles.overlayFocused : '',
                    region.kind === 'diagram' ? styles.overlayDiagram : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                  }}
                >
                  <span
                    className={`${styles.tag} ${label ? '' : styles.tagUnmapped}`}
                  >
                    {label ?? 'Unmapped'}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Header({
  zoom,
  page,
  pageCount,
  onZoomIn,
  onZoomOut,
  onPrev,
  onNext,
}: {
  zoom: number;
  page: number;
  pageCount: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className={styles.header}>
      <span className={styles.title}>Answer Sheet</span>

      <div className={styles.controls}>
        <div className={styles.control}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onZoomOut}
            disabled={zoom <= ZOOM_STEPS[0]!}
            aria-label="Zoom out"
          >
            <Minus size={24} />
          </button>
          <span className={styles.controlValue}>{zoom}%</span>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onZoomIn}
            disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!}
            aria-label="Zoom in"
          >
            <Plus size={24} />
          </button>
        </div>

        <div className={styles.control}>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onPrev}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <Chevron direction="left" size={24} />
          </button>
          <span className={`${styles.controlValue} ${styles.controlValueWide}`}>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className={styles.controlButton}
            onClick={onNext}
            disabled={page >= pageCount}
            aria-label="Next page"
          >
            <Chevron direction="right" size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import Image from 'next/image';
import { useId, useRef, useState, type DragEvent } from 'react';
import styles from './UploadDropzone.module.css';

/**
 * The two upload panes (Figma `1:8774` empty, `1:8827` filled).
 *
 * A pane holds one file. The design shows the filename, size and page count;
 * page count is only knowable after the server has prepared the document, so
 * it is shown when the backend reports it and omitted until then rather than
 * guessed from the file size.
 */

export interface SelectedFile {
  file: File;
  /** Filled in once the upload response comes back. Null while unknown. */
  pageCount: number | null;
}

interface PaneProps {
  title: string;
  highlight: string;
  selected: SelectedFile | null;
  error: string | null;
  disabled?: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

/** Matches the accept list the upload route enforces server-side. */
const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb % 1 === 0 ? mb : mb.toFixed(mb < 10 ? 1 : 0)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

function Pane({
  title,
  highlight,
  selected,
  error,
  disabled,
  onSelect,
  onRemove,
}: PaneProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;

    const file = event.dataTransfer.files?.[0];
    if (file) onSelect(file);
  }

  const paneClass = [
    styles.pane,
    selected ? '' : styles.paneEmpty,
    dragging ? styles.paneDragging : '',
    error ? styles.paneInvalid : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (selected) {
    const { file, pageCount } = selected;

    return (
      <div className={paneClass}>
        <div className={styles.file}>
          <span className={styles.fileIconFrame}>
            <Image
              className={styles.fileIcon}
              src="/figma/icon-file-pdf.png"
              alt=""
              width={50}
              height={50}
            />
          </span>
          <div className={styles.fileText}>
            <span className={styles.fileName} title={file.name}>
              {file.name}
            </span>
            <span className={styles.fileMeta}>
              <span className={styles.fileMetaText}>{formatSize(file.size)}</span>
              {pageCount !== null ? (
                <>
                  <Image
                    className={styles.fileMetaDot}
                    src="/figma/dot-separator.svg"
                    alt=""
                    width={5}
                    height={5}
                  />
                  <span className={styles.fileMetaText}>
                    {pageCount} {pageCount === 1 ? 'Page' : 'Pages'}
                  </span>
                </>
              ) : null}
            </span>
          </div>
        </div>

        <button
          type="button"
          className={styles.remove}
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${file.name}`}
        >
          <Image
            className={styles.removeIcon}
            src="/figma/icon-close.svg"
            alt=""
            width={10}
            height={10}
          />
        </button>
      </div>
    );
  }

  return (
    <div
      className={paneClass}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-labelledby={inputId}
    >
      <input
        ref={inputRef}
        id={inputId}
        className={styles.input}
        type="file"
        accept={ACCEPT}
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onSelect(file);
          // Clear, so re-picking the same file still fires a change event.
          event.target.value = '';
        }}
      />

      <div className={styles.prompt}>
        <span className={styles.promptIcon}>
          <Image
            className={styles.promptIconGlyph}
            src="/figma/icon-upload.svg"
            alt=""
            width={21}
            height={21}
          />
        </span>
        <span className={styles.promptText}>
          <span className={styles.promptTitle}>
            Upload <em>{highlight}</em>
          </span>
          <span className={styles.promptHint}>Max 10MB</span>
          {error ? <span className={styles.error}>{error}</span> : null}
        </span>
      </div>
      <span hidden>{title}</span>
    </div>
  );
}

interface UploadDropzoneProps {
  questionPaper: SelectedFile | null;
  answerSheet: SelectedFile | null;
  errors: { questionPaper: string | null; answerSheet: string | null };
  disabled?: boolean;
  onSelect: (slot: 'questionPaper' | 'answerSheet', file: File) => void;
  onRemove: (slot: 'questionPaper' | 'answerSheet') => void;
}

export function UploadDropzone({
  questionPaper,
  answerSheet,
  errors,
  disabled,
  onSelect,
  onRemove,
}: UploadDropzoneProps) {
  return (
    <div className={styles.tray}>
      <div className={styles.row}>
        <Pane
          title="Question paper"
          highlight="Question Paper"
          selected={questionPaper}
          error={errors.questionPaper}
          disabled={disabled}
          onSelect={(file) => onSelect('questionPaper', file)}
          onRemove={() => onRemove('questionPaper')}
        />
        <Pane
          title="Answer sheet"
          highlight="Answer Sheet"
          selected={answerSheet}
          error={errors.answerSheet}
          disabled={disabled}
          onSelect={(file) => onSelect('answerSheet', file)}
          onRemove={() => onRemove('answerSheet')}
        />
      </div>
    </div>
  );
}

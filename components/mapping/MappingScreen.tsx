'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';
import { useMappingData } from '@/lib/api-client/useMappingData';
import type { GradeItem } from '@/lib/api-client/types';
import { PrimaryButton } from '@/components/ui/PrimaryButton';
import { PageViewer } from './PageViewer';
import { QuestionCard } from './QuestionCard';
import styles from './MappingScreen.module.css';

/**
 * Question ↔ answer mapping (Figma `1:8861`).
 *
 * Two panes: the extracted questions with what each scored, and the answer
 * sheet with the mapped regions drawn over it. Everything shown is read from
 * the existing API — the questions, the answers, the mapping the system
 * currently acts on, and the grades. Nothing is recomputed here.
 *
 * Expanding a question also focuses its answer in the viewer, which is what
 * makes the two panes one screen rather than two lists side by side.
 */
export function MappingScreen({ assessmentId }: { assessmentId: string }) {
  const {
    questions,
    answers,
    mappings,
    grades,
    summary,
    documents,
    loading,
    error,
    notFound,
    reload,
  } = useMappingData(assessmentId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [pane, setPane] = useState<'questions' | 'answers'>('questions');

  /** The question currently in force for each answer. */
  const effectiveByAnswerId = useMemo(
    () => new Map(mappings.map((m) => [m.answerId, m.effectiveMapping.questionId])),
    [mappings],
  );

  /** The reverse: which answer a question holds, so a card can focus it. */
  const answerByQuestionId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [answerId, questionId] of effectiveByAnswerId) {
      if (questionId) map.set(questionId, answerId);
    }
    return map;
  }, [effectiveByAnswerId]);

  const gradeByQuestionId = useMemo(() => {
    const map = new Map<string, GradeItem>();
    for (const grade of grades) {
      if (grade.questionId) map.set(grade.questionId, grade);
    }
    return map;
  }, [grades]);

  const answerSheet = useMemo(
    () => documents.find((d) => d.type === 'ANSWER_SHEET') ?? null,
    [documents],
  );

  /*
   * The number each card shows.
   *
   * It has to be the number the paper prints, not the row's position in the
   * list. A paper that offers an alternative prints "OR" between two questions
   * without numbering it, so counting rows drifts one ahead of the paper from
   * that point on and every card below it names the wrong question. The label
   * is the source; an unnumbered row borrows the number it sits under, which
   * is exactly what the paper means by it.
   */
  const displayNumberByQuestionId = useMemo(() => {
    const numbers = new Map<string, string>();
    let lastPrinted = '';

    questions.forEach((question, index) => {
      const printed =
        question.parentLabel?.replace(/\D/g, '') || question.labelRaw.match(/\d+/)?.[0] || '';

      if (printed) lastPrinted = printed;

      numbers.set(question.id, printed || lastPrinted || String(index + 1));
    });

    return numbers;
  }, [questions]);

  /*
   * The paper as a whole.
   *
   * Every figure is counted from what the API returned, and the score is shown
   * only when marks genuinely exist: a paper that prints no marks per question
   * has no denominator, and a percentage invented for it would be the one
   * number on the screen that means nothing. `availableMarks` is what was
   * actually marked, not the whole paper, so it never reports a student who
   * answered half the questions as having lost the other half.
   */
  const overview = useMemo(() => {
    const marked = grades.filter(
      (grade) => grade.awardedMarks !== null && grade.maximumMarks !== null,
    );

    const correct = marked.filter((g) => g.awardedMarks! >= g.maximumMarks!).length;
    const incorrect = marked.filter((g) => g.awardedMarks! <= 0).length;

    return {
      questions: questions.length,
      answered: answerByQuestionId.size,
      unanswered: questions.length - answerByQuestionId.size,
      unmatched: mappings.filter((m) => m.effectiveMapping.questionId === null).length,
      correct,
      partial: marked.length - correct - incorrect,
      incorrect,
      notGradeable: grades.filter((g) => g.status === 'NOT_GRADEABLE').length,
      failed: grades.filter((g) => g.status === 'FAILED').length,
      awardedMarks: summary?.awardedMarks ?? null,
      availableMarks: summary?.availableMarks ?? null,
    };
  }, [questions, answerByQuestionId, mappings, grades, summary]);

  // A card opens if there is something to show: a mapped answer to highlight,
  // or grading feedback to read. "Expand All" reflects the same rule.
  const expandableIds = useMemo(
    () =>
      questions
        .filter(
          (q) =>
            answerByQuestionId.has(q.id) || Boolean(gradeByQuestionId.get(q.id)?.feedback),
        )
        .map((q) => q.id),
    [questions, answerByQuestionId, gradeByQuestionId],
  );

  const allExpanded = expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id));

  /*
   * The highlight follows the question the teacher clicked last, not whichever
   * open card happens to come first in the list. With several cards open those
   * are different questions, and the viewer jumping to an older selection
   * reads as the highlight landing on the wrong answer.
   */
  const focusedAnswerId = useMemo(
    () => (selectedQuestionId ? answerByQuestionId.get(selectedQuestionId) ?? null : null),
    [selectedQuestionId, answerByQuestionId],
  );

  function toggle(questionId: string) {
    const opening = !expanded.has(questionId);

    setExpanded((current) => {
      const next = new Set(current);

      if (opening) next.add(questionId);
      else next.delete(questionId);

      return next;
    });

    setSelectedQuestionId(opening ? questionId : null);
  }

  if (notFound) {
    return (
      <div className={styles.screen}>
        <div className={styles.state}>
          <p className={styles.stateTitle}>Assessment not found</p>
          <p className={styles.stateBody}>{error}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.screen}>
        <div className={styles.state}>
          <p className={styles.stateBody}>Loading the mapping…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.screen}>
        <div className={styles.state}>
          <p className={styles.stateTitle}>Could not load this assessment</p>
          <p className={styles.stateBody}>{error}</p>
          <PrimaryButton onClick={reload}>Try again</PrimaryButton>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <span className={`${styles.glow} ${styles.glowTop}`} aria-hidden="true">
        <Image src="/figma/bg-ellipse-17.svg" alt="" width={1113} height={428} />
      </span>

      <div
        className={`${styles.left} ${pane === 'answers' ? styles.paneHidden : ''}`}
      >
        <div className={styles.leftInner}>
          <div className={styles.listHeader}>
            <span className={styles.listTitle}>
              Extracted Questions (from question paper)
            </span>

            <div className={styles.toggle}>
              <button
                type="button"
                className={`${styles.toggleOption} ${styles.toggleOptionActive}`}
                onClick={() => setPane('questions')}
              >
                Questions
              </button>
              <button
                type="button"
                className={styles.toggleOption}
                onClick={() => setPane('answers')}
              >
                Answers
              </button>
            </div>

            <button
              type="button"
              className={styles.expandAll}
              onClick={() => {
                setExpanded(allExpanded ? new Set() : new Set(expandableIds));
                if (allExpanded) setSelectedQuestionId(null);
              }}
              disabled={expandableIds.length === 0}
            >
              {allExpanded ? 'Collapse All' : 'Expand All'}
            </button>
          </div>

          <div className={styles.summary}>
            <Stat label="Questions" value={overview.questions} />
            <Stat label="Answered" value={overview.answered} />
            <Stat label="Unanswered" value={overview.unanswered} />
            <Stat label="Unmatched answers" value={overview.unmatched} />
            <Stat label="Correct" value={overview.correct} />
            <Stat label="Partial" value={overview.partial} />
            <Stat label="Incorrect" value={overview.incorrect} />

            {overview.availableMarks !== null && overview.availableMarks > 0 ? (
              <span className={`${styles.summaryStat} ${styles.summaryScore}`}>
                <span className={styles.summaryValue}>
                  {overview.awardedMarks} / {overview.availableMarks}
                </span>
                <span>marks on the answers that were marked</span>
              </span>
            ) : (
              <span className={styles.summaryNote}>
                No score: this paper prints no marks to grade against.
              </span>
            )}

            {overview.notGradeable + overview.failed > 0 ? (
              <span className={styles.summaryNote}>
                {overview.notGradeable > 0
                  ? `${overview.notGradeable} answer(s) had nothing to grade against.`
                  : ''}{' '}
                {overview.failed > 0 ? `${overview.failed} could not be marked.` : ''}
              </span>
            ) : null}
          </div>

          {questions.map((question, index) => (
            <QuestionCard
              key={question.id}
              question={question}
              grade={gradeByQuestionId.get(question.id) ?? null}
              hasAnswer={answerByQuestionId.has(question.id)}
              displayNumber={displayNumberByQuestionId.get(question.id) ?? String(index + 1)}
              expanded={expanded.has(question.id)}
              onToggle={() => toggle(question.id)}
            />
          ))}
        </div>
      </div>

      <div className={`${styles.right} ${pane === 'questions' ? styles.paneHidden : ''}`}>
        <div className={styles.toggle}>
          <button
            type="button"
            className={styles.toggleOption}
            onClick={() => setPane('questions')}
          >
            Questions
          </button>
          <button
            type="button"
            className={`${styles.toggleOption} ${styles.toggleOptionActive}`}
            onClick={() => setPane('answers')}
          >
            Answers
          </button>
        </div>

        <PageViewer
          assessmentId={assessmentId}
          document={answerSheet}
          answers={answers}
          questions={questions}
          effectiveByAnswerId={effectiveByAnswerId}
          focusedAnswerId={focusedAnswerId}
        />
      </div>
    </div>
  );
}

/** One count in the overall strip. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className={styles.summaryStat}>
      <span className={styles.summaryValue}>{value}</span>
      <span>{label}</span>
    </span>
  );
}

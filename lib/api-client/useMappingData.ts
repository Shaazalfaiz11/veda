'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getAnswers,
  getDocuments,
  getGrades,
  getMappings,
  getQuestions,
} from './client';
import type {
  Answer,
  DocumentWithPages,
  GradeItem,
  GradingSummary,
  MappingEntry,
  Question,
} from './types';

/**
 * Everything the mapping screen renders, fetched from the routes that already
 * exist.
 *
 * Five requests in parallel rather than one aggregate endpoint: each is a
 * route the backend already exposes, and inventing a sixth that returns the
 * union would put a second copy of the join in the codebase.
 */

export interface MappingData {
  questions: Question[];
  answers: Answer[];
  mappings: MappingEntry[];
  grades: GradeItem[];
  summary: GradingSummary | null;
  documents: DocumentWithPages[];
}

export interface MappingDataState extends MappingData {
  loading: boolean;
  error: string | null;
  notFound: boolean;
  reload: () => void;
}

const EMPTY: MappingData = {
  questions: [],
  answers: [],
  mappings: [],
  grades: [],
  summary: null,
  documents: [],
};

export function useMappingData(assessmentId: string): MappingDataState {
  const [data, setData] = useState<MappingData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      try {
        const [questions, answers, mappings, grades, documents] = await Promise.all([
          getQuestions(assessmentId),
          getAnswers(assessmentId),
          getMappings(assessmentId),
          getGrades(assessmentId),
          getDocuments(assessmentId),
        ]);

        if (cancelled) return;

        setData({
          questions: questions.questions,
          answers: answers.answers,
          mappings: mappings.mappings,
          grades: grades.grades,
          summary: grades.summary,
          documents: documents.documents,
        });
        setError(null);
        setNotFound(false);
      } catch (cause) {
        if (cancelled) return;

        const missing =
          cause instanceof ApiError && (cause.status === 404 || cause.status === 400);

        setNotFound(missing);
        setError(
          cause instanceof ApiError ? cause.message : 'The assessment could not be loaded.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [assessmentId, nonce]);

  return { ...data, loading, error, notFound, reload };
}

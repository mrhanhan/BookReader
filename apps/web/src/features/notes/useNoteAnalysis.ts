import { useEffect, useRef, useState } from 'react';
import type {
  NoteAnalysisDto,
  NoteAnalysisKind,
  NoteAnalysisSummaryDto,
  NoteFilters,
} from '@bookr/shared';
import {
  deleteNoteAnalysis,
  fetchNoteAnalyses,
  fetchNoteAnalysis,
  streamNoteAnalysis,
} from '../../api/notes';
import type { NoteAnalysisStreamHandlers } from '../../api/notes';
import { ApiError } from '../../api/client';
import { messageForApiError } from '../../lib/errorMessages';

/** Transport used by the analysis panel; tests inject a fake implementation. */
export interface NoteAnalysisApi {
  list(): Promise<NoteAnalysisSummaryDto[]>;
  get(id: string): Promise<NoteAnalysisDto>;
  remove(id: string): Promise<void>;
  stream(
    body: { kind: NoteAnalysisKind; filters?: NoteFilters },
    handlers: NoteAnalysisStreamHandlers,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

/** The real transport, backed by the notes REST and SSE endpoints. */
export const noteAnalysisApi: NoteAnalysisApi = {
  list: fetchNoteAnalyses,
  get: fetchNoteAnalysis,
  remove: deleteNoteAnalysis,
  stream: streamNoteAnalysis,
};

export type NoteAnalysisRunStatus =
  | 'idle'
  | 'streaming'
  | 'complete'
  | 'interrupted'
  | 'failed';

export interface NoteAnalysisController {
  kind: NoteAnalysisKind;
  setKind(kind: NoteAnalysisKind): void;
  running: boolean;
  content: string;
  status: NoteAnalysisRunStatus;
  error: string | null;
  noteCount: number | null;
  analyzedCount: number | null;
  run(): void;
  stop(): void;
  reset(): void;
}

const NO_NOTES_MESSAGE = '当前筛选下没有可分析的笔记';

/** Maps a request failure to the copy the panel shows as-is. */
export function messageForNoteAnalysisError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === 'VALIDATION_FAILED' &&
    error.details?.reason === 'no_notes'
  ) {
    return NO_NOTES_MESSAGE;
  }
  return messageForApiError(error);
}

function isAbortError(error: unknown): boolean {
  // jsdom's DOMException is not an Error subclass, so sniff the name instead
  // of narrowing through `instanceof`.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Runs one streamed note analysis at a time. The request captures the filters
 * and kind that were active when it started, so changing either while it runs
 * never restarts work behind the reader's back; `run()` starts the next pass.
 */
export function useNoteAnalysis(
  api: NoteAnalysisApi,
  filters: NoteFilters,
): NoteAnalysisController {
  const [kind, setKindState] = useState<NoteAnalysisKind>('themes');
  const [running, setRunning] = useState(false);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<NoteAnalysisRunStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState<number | null>(null);
  const [analyzedCount, setAnalyzedCount] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  // Requests carry a token so an unmount or reset discards late handlers.
  const tokenRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  function setKind(next: NoteAnalysisKind): void {
    setKindState(next);
  }

  function run(): void {
    if (abortRef.current) return;

    const token = tokenRef.current + 1;
    tokenRef.current = token;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestKind = kind;
    const requestFilters = filters;

    const isCurrent = () => aliveRef.current && tokenRef.current === token;

    setRunning(true);
    setStatus('streaming');
    setContent('');
    setError(null);
    setNoteCount(null);
    setAnalyzedCount(null);

    void (async () => {
      try {
        await api.stream(
          { kind: requestKind, filters: requestFilters },
          {
            onMeta(meta) {
              if (!isCurrent()) return;
              setNoteCount(meta.noteCount);
              setAnalyzedCount(meta.analyzedCount);
            },
            onDelta(text) {
              if (!isCurrent()) return;
              setContent((previous) => previous + text);
            },
            onDone() {
              if (!isCurrent()) return;
              setStatus('complete');
            },
            onError(payload) {
              if (!isCurrent()) return;
              setError(payload.message);
              setStatus('failed');
            },
          },
          { signal: controller.signal },
        );
      } catch (caught) {
        if (!isCurrent()) return;
        if (isAbortError(caught)) {
          // Partial text stays on screen; the server already saved the row.
          setStatus('interrupted');
        } else {
          setError(messageForNoteAnalysisError(caught));
          setStatus('failed');
        }
      } finally {
        if (isCurrent()) {
          abortRef.current = null;
          setRunning(false);
        }
      }
    })();
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  function reset(): void {
    tokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setStatus('idle');
    setContent('');
    setError(null);
    setNoteCount(null);
    setAnalyzedCount(null);
  }

  return {
    kind,
    setKind,
    running,
    content,
    status,
    error,
    noteCount,
    analyzedCount,
    run,
    stop,
    reset,
  };
}

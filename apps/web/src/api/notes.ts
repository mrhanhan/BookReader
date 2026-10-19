import type {
  AiStreamErrorPayload,
  NoteAnalysisDto,
  NoteAnalysisKind,
  NoteAnalysisStreamDone,
  NoteAnalysisStreamMeta,
  NoteAnalysisSummaryDto,
  NoteFilters,
  NoteListResponse,
  NoteTagCount,
} from '@bookr/shared';
import { parseSseJson, readSseStream, SseProtocolError } from '../lib/sse';
import { apiFetch, authorizedFetch } from './client';

/** Query-key prefix shared by every notes list. */
export const NOTES_QUERY_KEY = 'notes' as const;

export function notesQueryKey(filters: NoteFilters): readonly ['notes', NoteFilters] {
  return ['notes', filters];
}

type NotesQuery = NoteFilters & { page?: number; pageSize?: number };

/**
 * Serializes note filters, omitting blank values so the server applies its
 * defaults. Paging is only sent when the caller asked for it.
 */
export function buildNotesQueryString(query: NotesQuery): string {
  const params = new URLSearchParams();
  const search = query.q?.trim();
  if (search) params.set('q', search);
  if (query.bookId) params.set('bookId', query.bookId);
  if (query.tag) params.set('tag', query.tag);
  if (query.type) params.set('type', query.type);
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  return params.toString();
}

function withQuery(path: string, query: string): string {
  return query === '' ? path : `${path}?${query}`;
}

/** One page of the caller's notes, newest first. */
export function fetchNotes(query: NotesQuery): Promise<NoteListResponse> {
  return apiFetch<NoteListResponse>(
    withQuery('/api/notes', buildNotesQueryString(query)),
  );
}

/** Distinct tags across the caller's notes, with usage counts. */
export async function fetchNoteTags(): Promise<NoteTagCount[]> {
  const result = await apiFetch<{ items: NoteTagCount[] }>('/api/notes/tags');
  return result.items;
}

/**
 * Extracts the download name from a `content-disposition` header. RFC 5987
 * `filename*` wins over the ASCII `filename` fallback.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (extended) {
    const raw = extended[1]?.trim().replace(/^"(.*)"$/, '$1') ?? '';
    const parts = /^([^']*)'([^']*)'(.*)$/.exec(raw);
    const encoded = parts ? parts[3] : raw;
    if (encoded) {
      try {
        return decodeURIComponent(encoded);
      } catch {
        // A malformed percent escape falls back to the plain filename.
      }
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (!plain) return null;
  const value = (plain[1] ?? plain[2] ?? '').trim();
  return value === '' ? null : value;
}

/** Downloads the filtered notes as a Markdown attachment. */
export async function downloadNotesExport(
  filters: NoteFilters,
): Promise<{ blob: Blob; filename: string }> {
  const response = await authorizedFetch(
    withQuery('/api/notes/export', buildNotesQueryString(filters)),
  );
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('content-disposition')) ?? '笔记库.md',
  };
}

/** Callbacks invoked as an analysis stream progresses. */
export interface NoteAnalysisStreamHandlers {
  onMeta(meta: NoteAnalysisStreamMeta): void;
  onDelta(text: string): void;
  onDone(done: NoteAnalysisStreamDone): void;
  onError(payload: AiStreamErrorPayload): void;
}

/**
 * Runs one note analysis. An `error` frame is delivered to `onError` and ends
 * normally; transport, protocol and HTTP failures reject. An aborted signal
 * keeps its `AbortError` so the caller can distinguish "user stopped".
 */
export async function streamNoteAnalysis(
  body: { kind: NoteAnalysisKind; filters?: NoteFilters },
  handlers: NoteAnalysisStreamHandlers,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const response = await authorizedFetch('/api/notes/analyses', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.body) throw new SseProtocolError('AI 流意外结束');

  let finished = false;

  await readSseStream(response.body, (frame) => {
    switch (frame.event) {
      case 'meta':
        handlers.onMeta(parseSseJson<NoteAnalysisStreamMeta>(frame.data));
        break;
      case 'delta': {
        const payload = parseSseJson<{ text: string }>(frame.data);
        handlers.onDelta(payload.text);
        break;
      }
      case 'done':
        handlers.onDone(parseSseJson<NoteAnalysisStreamDone>(frame.data));
        finished = true;
        break;
      case 'error':
        handlers.onError(parseSseJson<AiStreamErrorPayload>(frame.data));
        finished = true;
        break;
      default:
        // Unknown event names are reserved for forward-compatible additions.
        break;
    }
  });

  if (!finished) throw new SseProtocolError('AI 流意外结束');
}

/** Saved analyses, newest first; streaming rows are hidden by the server. */
export async function fetchNoteAnalyses(): Promise<NoteAnalysisSummaryDto[]> {
  const result = await apiFetch<{ items: NoteAnalysisSummaryDto[] }>('/api/notes/analyses');
  return result.items;
}

/** One saved analysis including its generated content and scope. */
export async function fetchNoteAnalysis(id: string): Promise<NoteAnalysisDto> {
  const result = await apiFetch<{ analysis: NoteAnalysisDto }>(`/api/notes/analyses/${id}`);
  return result.analysis;
}

export async function deleteNoteAnalysis(id: string): Promise<void> {
  await apiFetch<void>(`/api/notes/analyses/${id}`, { method: 'DELETE' });
}

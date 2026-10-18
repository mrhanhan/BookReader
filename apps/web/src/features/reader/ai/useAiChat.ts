import { useEffect, useRef, useState } from 'react';
import { AI_THREAD_TITLE_MAX_LENGTH } from '@bookr/shared';
import type {
  AiAction,
  AiChatRequest,
  AiMessageDto,
  AiThreadDto,
  AiUsageDto,
  Locator,
} from '@bookr/shared';
import type { ReaderContextScope } from '@bookr/reader-core';
import {
  deleteAiThread,
  fetchAiThread,
  fetchAiThreads,
  fetchAiUsage,
  streamAiChat,
} from '../../../api/ai';
import type { AiStreamHandlers } from '../../../api/ai';
import { ApiError, isNetworkError } from '../../../api/client';

/** Text context the reader can supply for an AI request. */
export interface AiContextSource {
  getTextContext(scope: ReaderContextScope): Promise<{ text: string; label: string }>;
  currentLocator(): Locator | null;
}

/** Transport used by the hook; tests and other hosts can replace any part. */
export interface AiApi {
  fetchThreads(bookId: string): Promise<AiThreadDto[]>;
  fetchThread(threadId: string): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }>;
  fetchUsage(): Promise<AiUsageDto>;
  deleteThread(threadId: string): Promise<void>;
  streamChat: typeof streamAiChat;
}

export type AiDisabledReason = 'offline' | 'disabled' | 'unconfigured' | 'quota' | null;

export interface AiChatController {
  threads: AiThreadDto[];
  activeThread: AiThreadDto | null;
  messages: AiMessageDto[];
  usage: AiUsageDto | null;
  loading: boolean;
  streaming: boolean;
  error: string | null;
  disabledReason: AiDisabledReason;
  canSend: boolean;
  openThread(threadId: string): Promise<void>;
  newThread(): void;
  explain(selection: { text: string; locator: Locator }): Promise<boolean>;
  summarize(scope: 'page' | 'chapter'): Promise<boolean>;
  ask(question: string, selection?: { text: string; locator: Locator }): Promise<boolean>;
  send(question: string): Promise<boolean>;
  stop(): void;
  retry(): Promise<boolean>;
  removeThread(threadId: string): Promise<void>;
  refreshUsage(): Promise<void>;
  dismissError(): void;
}

export interface UseAiChatOptions {
  bookId: string;
  offline: boolean;
  context: AiContextSource;
  api?: Partial<AiApi>;
}

const DEFAULT_API: AiApi = {
  fetchThreads: fetchAiThreads,
  fetchThread: fetchAiThread,
  fetchUsage: fetchAiUsage,
  deleteThread: deleteAiThread,
  streamChat: streamAiChat,
};

const USAGE_ERROR = '无法读取 AI 状态，请稍后重试';
const EMPTY_CONTEXT_ERROR = '暂时无法获取本页文字，请稍后再试';
const THREAD_ERROR = '无法加载对话，请稍后重试';
const UNAVAILABLE_ERROR = 'AI 服务暂时不可用，请稍后重试';
const NETWORK_ERROR = '网络不可用，请检查网络后重试';
const TIMEOUT_ERROR = 'AI 响应超时，请稍后重试';
const DISABLED_ERROR = 'AI 伴读已在设置中关闭';
const UNCONFIGURED_ERROR = 'AI 尚未配置，请联系管理员';
const QUOTA_ERROR = '今日或本月额度已用尽，额度会按用户时区重置';

function tempId(): string {
  return `temp-${Date.now()}-${Math.random()}`;
}

function quotaExhausted(window: { used: number; reserved: number; limit: number }): boolean {
  return window.used + window.reserved >= window.limit;
}

/** Availability precedence: offline wins over every server-reported reason. */
function deriveDisabledReason(offline: boolean, usage: AiUsageDto | null): AiDisabledReason {
  if (offline) return 'offline';
  if (!usage) return null;
  if (!usage.enabled) return 'disabled';
  if (!usage.configured) return 'unconfigured';
  if (quotaExhausted(usage.daily) || quotaExhausted(usage.monthly)) return 'quota';
  return null;
}

/** Maps transport and API failures to copy the companion can show as-is. */
function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'AI_QUOTA_EXCEEDED') return QUOTA_ERROR;
    if (error.code === 'AI_NOT_CONFIGURED') return UNCONFIGURED_ERROR;
    if (error.code === 'AI_DISABLED') return DISABLED_ERROR;
    if (error.code === 'AI_TIMEOUT') return TIMEOUT_ERROR;
    return UNAVAILABLE_ERROR;
  }
  if (isNetworkError(error)) return NETWORK_ERROR;
  return UNAVAILABLE_ERROR;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function threadTitle(body: AiChatRequest): string {
  if (body.action === 'summarize') return body.scope === 'chapter' ? '总结本章' : '总结本页';
  if (body.question) return body.question.slice(0, AI_THREAD_TITLE_MAX_LENGTH);
  if (body.selectedText) {
    return `解释：${body.selectedText}`.slice(0, AI_THREAD_TITLE_MAX_LENGTH);
  }
  return 'AI 对话';
}

interface PendingRequest {
  body: AiChatRequest;
  userContent: string;
  userAction: AiAction;
  userSelectedText: string | null;
}

/**
 * Owns the AI companion's conversation state for one book: the thread list,
 * the open transcript, quota usage and the streaming exchange. Transport is
 * injected so the reader can present optimistic messages without knowing how
 * the server frames them.
 */
export function useAiChat({ bookId, offline, context, api }: UseAiChatOptions): AiChatController {
  const [threads, setThreads] = useState<AiThreadDto[]>([]);
  const [activeThread, setActiveThread] = useState<AiThreadDto | null>(null);
  const [messages, setMessages] = useState<AiMessageDto[]>([]);
  const [usage, setUsage] = useState<AiUsageDto | null>(null);
  const [loading, setLoading] = useState(bookId !== '');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disabledReason = deriveDisabledReason(offline, usage);
  const canSend =
    bookId !== '' && usage !== null && !streaming && !loading && disabledReason === null;

  const apiRef = useRef<AiApi>({ ...DEFAULT_API, ...api });
  const contextRef = useRef(context);
  const latest = useRef({ usage, activeThread, threads, disabledReason });
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef(0);
  const lastSentRef = useRef<{ request: PendingRequest; threadId: string | null } | null>(null);

  useEffect(() => {
    apiRef.current = { ...DEFAULT_API, ...api };
    contextRef.current = context;
    latest.current = { usage, activeThread, threads, disabledReason };
  });

  function applyUsage(next: AiUsageDto): void {
    setUsage(next);
    latest.current = { ...latest.current, usage: next };
  }

  function applyThread(next: AiThreadDto | null): void {
    setActiveThread(next);
    latest.current = { ...latest.current, activeThread: next };
  }

  function applyThreads(next: AiThreadDto[]): void {
    setThreads(next);
    latest.current = { ...latest.current, threads: next };
  }

  /** Replaces the transcript after a stream settles; failures keep it intact. */
  async function refreshThread(threadId: string, token: number): Promise<void> {
    try {
      const result = await apiRef.current.fetchThread(threadId);
      if (tokenRef.current !== token) return;
      applyThread(result.thread);
      setMessages(result.messages);
      applyThreads(
        latest.current.threads.some((item) => item.id === result.thread.id)
          ? latest.current.threads.map((item) =>
              item.id === result.thread.id ? result.thread : item,
            )
          : [result.thread, ...latest.current.threads],
      );
    } catch {
      // Refreshing is best effort: the optimistic transcript remains usable.
    }

    try {
      const list = await apiRef.current.fetchThreads(bookId);
      if (tokenRef.current !== token) return;
      applyThreads(list);
    } catch {
      // The previous list is better than an empty one.
    }
  }

  useEffect(() => {
    tokenRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    streamingRef.current = false;
    setStreaming(false);
    setError(null);

    if (bookId === '') {
      setLoading(false);
      setUsage(null);
      applyThread(null);
      applyThreads([]);
      setMessages([]);
      return;
    }

    const generation = tokenRef.current;
    let cancelled = false;
    setLoading(true);
    setUsage(null);
    applyThread(null);
    applyThreads([]);
    setMessages([]);

    void (async () => {
      const [usageResult, threadsResult] = await Promise.allSettled([
        apiRef.current.fetchUsage(),
        apiRef.current.fetchThreads(bookId),
      ]);
      if (cancelled || tokenRef.current !== generation) return;

      if (usageResult.status === 'fulfilled') {
        applyUsage(usageResult.value);
      } else {
        setUsage(null);
        setError(USAGE_ERROR);
      }
      setLoading(false);

      if (threadsResult.status === 'rejected') {
        applyThreads([]);
        return;
      }

      const list = threadsResult.value;
      applyThreads(list);
      const first = list[0];
      if (!first) return;

      applyThread(first);
      try {
        const result = await apiRef.current.fetchThread(first.id);
        if (cancelled || tokenRef.current !== generation) return;
        applyThread(result.thread);
        setMessages(result.messages);
      } catch {
        // An unreadable transcript still leaves the thread selected.
      }
    })();

    return () => {
      cancelled = true;
      tokenRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs carry the latest props
  }, [bookId]);

  async function runRequest(
    request: PendingRequest,
    threadIdOverride?: string | null,
  ): Promise<boolean> {
    const current = latest.current;
    if (
      bookId === '' ||
      current.usage === null ||
      current.disabledReason !== null ||
      streamingRef.current
    ) {
      return false;
    }

    const token = tokenRef.current + 1;
    tokenRef.current = token;
    const controller = new AbortController();
    abortRef.current = controller;
    streamingRef.current = true;

    const tempUserId = tempId();
    const tempAssistantId = tempId();
    const createdAt = new Date().toISOString();
    const tempThreadId = current.activeThread?.id ?? '';
    const tempUser: AiMessageDto = {
      id: tempUserId,
      threadId: tempThreadId,
      role: 'user',
      content: request.userContent,
      status: 'complete',
      action: request.userAction,
      selectedText: request.userSelectedText,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      createdAt,
    };
    const tempAssistant: AiMessageDto = {
      id: tempAssistantId,
      threadId: tempThreadId,
      role: 'assistant',
      content: '',
      status: 'streaming',
      action: null,
      selectedText: null,
      model: null,
      promptTokens: 0,
      completionTokens: 0,
      createdAt,
    };

    setMessages((previous) => [...previous, tempUser, tempAssistant]);
    setStreaming(true);
    setError(null);

    lastSentRef.current = {
      request,
      threadId: threadIdOverride ?? request.body.threadId ?? null,
    };

    let assistantId = tempAssistantId;
    let currentThreadId: string | null = threadIdOverride ?? request.body.threadId ?? null;
    let metaReceived = false;
    let doneReceived = false;
    let aborted = false;
    let failureMessage: string | null = null;
    const isCurrent = (): boolean => tokenRef.current === token;

    const handlers: AiStreamHandlers = {
      onMeta(meta) {
        if (!isCurrent()) return;
        metaReceived = true;
        assistantId = meta.assistantMessageId;
        currentThreadId = meta.threadId;
        lastSentRef.current = { request, threadId: meta.threadId };
        setMessages((previous) =>
          previous.map((message) => {
            if (message.id === tempUserId) {
              return { ...message, id: meta.userMessageId, threadId: meta.threadId };
            }
            if (message.id === tempAssistantId) {
              return {
                ...message,
                id: meta.assistantMessageId,
                threadId: meta.threadId,
                model: meta.model,
              };
            }
            return message;
          }),
        );
        const known = latest.current.threads.find((item) => item.id === meta.threadId);
        const created: AiThreadDto = known ?? {
          id: meta.threadId,
          bookId,
          title: threadTitle(request.body),
          anchorLocator: request.body.locator ?? null,
          messageCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        applyThread(created);
        if (!known) applyThreads([created, ...latest.current.threads]);
      },
      onDelta(text) {
        if (!isCurrent()) return;
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? { ...message, content: message.content + text }
              : message,
          ),
        );
      },
      onDone(result) {
        if (!isCurrent()) return;
        doneReceived = true;
        assistantId = result.assistantMessageId;
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId ? { ...message, status: 'complete' } : message,
          ),
        );
        const previousUsage = latest.current.usage;
        if (previousUsage) {
          applyUsage({
            ...previousUsage,
            daily: result.quota.daily,
            monthly: result.quota.monthly,
          });
        }
      },
      onError(payload) {
        if (!isCurrent()) return;
        failureMessage = payload.message;
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId ? { ...message, status: 'failed' } : message,
          ),
        );
        setError(payload.message);
      },
    };

    const body: AiChatRequest = threadIdOverride
      ? { ...request.body, threadId: threadIdOverride }
      : request.body;

    try {
      await apiRef.current.streamChat(bookId, body, handlers, { signal: controller.signal });
    } catch (caught) {
      if (!isCurrent()) return false;
      if (isAbortError(caught)) {
        aborted = true;
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId ? { ...message, status: 'interrupted' } : message,
          ),
        );
      } else {
        setError(friendlyMessage(caught));
        if (!metaReceived) {
          // No server thread exists yet, so both optimistic rows must go.
          setMessages((previous) =>
            previous.filter(
              (message) => message.id !== tempUserId && message.id !== tempAssistantId,
            ),
          );
        } else {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === assistantId ? { ...message, status: 'failed' } : message,
            ),
          );
        }
      }
    }

    if (!isCurrent()) return false;

    setStreaming(false);
    streamingRef.current = false;
    abortRef.current = null;

    if (metaReceived && currentThreadId) await refreshThread(currentThreadId, token);

    return doneReceived && !aborted && failureMessage === null;
  }

  function newThread(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    applyThread(null);
    setMessages([]);
    setError(null);
  }

  async function openThread(threadId: string): Promise<void> {
    abortRef.current?.abort();
    abortRef.current = null;
    const known = latest.current.threads.find((item) => item.id === threadId) ?? null;
    applyThread(known);
    setMessages([]);
    const token = tokenRef.current;
    try {
      const result = await apiRef.current.fetchThread(threadId);
      if (tokenRef.current !== token) return;
      applyThread(result.thread);
      setMessages(result.messages);
    } catch {
      setError(THREAD_ERROR);
    }
  }

  async function explain(selection: { text: string; locator: Locator }): Promise<boolean> {
    if (selection.text.trim() === '') return false;

    let pageText: string | null = null;
    try {
      pageText = (await contextRef.current.getTextContext('page')).text;
    } catch {
      pageText = null;
    }

    const body: AiChatRequest = {
      action: 'explain',
      selectedText: selection.text,
      locator: selection.locator,
      ...(pageText ? { context: { pageText } } : {}),
    };
    return runRequest({
      body,
      userContent: selection.text,
      userAction: 'explain',
      userSelectedText: selection.text,
    });
  }

  async function summarize(scope: 'page' | 'chapter'): Promise<boolean> {
    let text = '';
    try {
      text = (await contextRef.current.getTextContext(scope)).text;
    } catch {
      text = '';
    }
    if (text.trim() === '') {
      setError(EMPTY_CONTEXT_ERROR);
      return false;
    }

    const locator = contextRef.current.currentLocator();
    const body: AiChatRequest = {
      action: 'summarize',
      scope,
      ...(locator ? { locator } : {}),
      context: scope === 'page' ? { pageText: text } : { chapterText: text },
    };
    return runRequest({
      body,
      userContent: scope === 'page' ? '总结本页' : '总结本章',
      userAction: 'summarize',
      userSelectedText: null,
    });
  }

  async function pageContext(): Promise<AiChatRequest['context']> {
    try {
      const text = (await contextRef.current.getTextContext('page')).text;
      return text ? { pageText: text } : undefined;
    } catch {
      return undefined;
    }
  }

  async function ask(
    question: string,
    selection?: { text: string; locator: Locator },
  ): Promise<boolean> {
    const trimmed = question.trim();
    if (trimmed === '') return false;

    const pageTextContext = await pageContext();
    if (selection) {
      const body: AiChatRequest = {
        action: 'ask',
        question: trimmed,
        selectedText: selection.text,
        locator: selection.locator,
        ...(pageTextContext ? { context: pageTextContext } : {}),
      };
      return runRequest({
        body,
        userContent: trimmed,
        userAction: 'ask',
        userSelectedText: selection.text,
      });
    }

    const thread = latest.current.activeThread;
    const body: AiChatRequest = {
      action: 'ask',
      question: trimmed,
      ...(thread ? { threadId: thread.id } : {}),
      ...(pageTextContext ? { context: pageTextContext } : {}),
    };
    return runRequest({
      body,
      userContent: trimmed,
      userAction: 'ask',
      userSelectedText: null,
    });
  }

  async function send(question: string): Promise<boolean> {
    return ask(question);
  }

  function stop(): void {
    abortRef.current?.abort();
  }

  async function retry(): Promise<boolean> {
    const last = lastSentRef.current;
    if (!last) return false;
    return runRequest(last.request, last.threadId);
  }

  async function removeThread(threadId: string): Promise<void> {
    if (bookId === '') return;
    try {
      await apiRef.current.deleteThread(threadId);
    } catch (caught) {
      setError(friendlyMessage(caught));
      return;
    }

    const remaining = latest.current.threads.filter((item) => item.id !== threadId);
    applyThreads(remaining);

    if (latest.current.activeThread?.id !== threadId) return;

    const next = remaining[0] ?? null;
    applyThread(next);
    setMessages([]);
    if (!next) return;
    try {
      const result = await apiRef.current.fetchThread(next.id);
      applyThread(result.thread);
      setMessages(result.messages);
    } catch {
      // The cleared transcript is the honest state when the next thread fails.
    }
  }

  async function refreshUsage(): Promise<void> {
    try {
      applyUsage(await apiRef.current.fetchUsage());
    } catch {
      setError(USAGE_ERROR);
    }
  }

  function dismissError(): void {
    setError(null);
  }

  return {
    threads,
    activeThread,
    messages,
    usage,
    loading,
    streaming,
    error,
    disabledReason,
    canSend,
    openThread,
    newThread,
    explain,
    summarize,
    ask,
    send,
    stop,
    retry,
    removeThread,
    refreshUsage,
    dismissError,
  };
}

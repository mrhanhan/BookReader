import { z } from 'zod';
import type { ErrorCode } from './errors';
import { locatorSchema, type Locator } from './locators';

/** Actions the reader can ask the AI companion to perform. */
export const AI_ACTIONS = ['explain', 'summarize', 'ask'] as const;

export type AiAction = (typeof AI_ACTIONS)[number];

/** Granularity of a summary request. */
export const AI_SUMMARY_SCOPES = ['page', 'chapter'] as const;

export type AiSummaryScope = (typeof AI_SUMMARY_SCOPES)[number];

/** Roles stored for a thread message; there is no system role in the transcript. */
export const AI_MESSAGE_ROLES = ['user', 'assistant'] as const;

export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];

/** Lifecycle of an assistant message, including stream interruptions. */
export const AI_MESSAGE_STATUSES = ['streaming', 'complete', 'interrupted', 'failed'] as const;

export type AiMessageStatus = (typeof AI_MESSAGE_STATUSES)[number];

/** Server-sent event names used by the streaming chat endpoint. */
export const AI_STREAM_EVENTS = ['meta', 'delta', 'done', 'error'] as const;

/** Token budget the server spends on book context for one request. */
export const AI_CONTEXT_TOKEN_BUDGET = 8_000;
/** Token budget reserved for prior thread messages in the prompt. */
export const AI_PROMPT_HISTORY_MAX_TOKENS = 2_000;
/** Hard cap on prior messages replayed into the prompt. */
export const AI_MAX_HISTORY_MESSAGES = 20;
/** Hard cap on the completion length requested from the provider. */
export const AI_MAX_OUTPUT_TOKENS = 2_048;
export const AI_MAX_QUESTION_LENGTH = 4_000;
export const AI_MAX_SELECTED_TEXT_LENGTH = 8_000;
export const AI_MAX_PAGE_TEXT_LENGTH = 20_000;
export const AI_MAX_CHAPTER_TEXT_LENGTH = 60_000;
export const AI_THREAD_TITLE_MAX_LENGTH = 80;
export const AI_DEFAULT_DAILY_TOKEN_LIMIT = 100_000;
export const AI_DEFAULT_MONTHLY_TOKEN_LIMIT = 1_000_000;

/** A conversation anchored to a book and, optionally, a reading location. */
export interface AiThreadDto {
  id: string;
  bookId: string;
  title: string;
  anchorLocator: Locator | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessageDto {
  id: string;
  threadId: string;
  role: AiMessageRole;
  content: string;
  status: AiMessageStatus;
  action: AiAction | null;
  selectedText: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  createdAt: string;
}

/** One quota window as reported to clients. */
export interface AiQuotaWindowDto {
  used: number;
  reserved: number;
  limit: number;
}

/** AI availability and quota snapshot for the settings page. */
export interface AiUsageDto {
  enabled: boolean;
  configured: boolean;
  fakeProvider: boolean;
  model: string | null;
  daily: AiQuotaWindowDto;
  monthly: AiQuotaWindowDto;
}

/** Payload of the first SSE frame of a chat response. */
export interface AiStreamMeta {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
  action: AiAction;
  model: string;
  promptVersion: string;
}

/** Payload of the final SSE frame of a successful chat response. */
export interface AiStreamDone {
  assistantMessageId: string;
  usage: { promptTokens: number; completionTokens: number };
  quota: { daily: AiQuotaWindowDto; monthly: AiQuotaWindowDto };
}

/** Payload of an SSE error frame. */
export interface AiStreamErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export const aiChatRequestSchema = z
  .object({
    action: z.enum(AI_ACTIONS),
    scope: z.enum(AI_SUMMARY_SCOPES).optional(),
    threadId: z.uuid().optional(),
    question: z.string().trim().min(1).max(AI_MAX_QUESTION_LENGTH).optional(),
    selectedText: z.string().trim().min(1).max(AI_MAX_SELECTED_TEXT_LENGTH).optional(),
    locator: locatorSchema.optional(),
    context: z
      .object({
        pageText: z.string().max(AI_MAX_PAGE_TEXT_LENGTH).optional(),
        chapterText: z.string().max(AI_MAX_CHAPTER_TEXT_LENGTH).optional(),
      })
      .optional(),
  })
  .superRefine((request, ctx) => {
    if (request.action === 'explain' && request.selectedText === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedText'],
        message: 'explain requires selectedText',
      });
    }

    if (request.action === 'ask' && request.question === undefined) {
      ctx.addIssue({ code: 'custom', path: ['question'], message: 'ask requires a question' });
    }

    if (request.action === 'summarize') {
      if (request.scope === undefined) {
        ctx.addIssue({ code: 'custom', path: ['scope'], message: 'summarize requires a scope' });
        return;
      }

      if (request.scope === 'page' && request.context?.pageText === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['context', 'pageText'],
          message: 'summarize with scope page requires context.pageText',
        });
      }

      if (request.scope === 'chapter' && request.context?.chapterText === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['context', 'chapterText'],
          message: 'summarize with scope chapter requires context.chapterText',
        });
      }
    }
  });

export type AiChatRequest = z.infer<typeof aiChatRequestSchema>;

/** Query parameters for listing the threads of a book. */
export const aiThreadListQuerySchema = z.object({
  bookId: z.uuid(),
});

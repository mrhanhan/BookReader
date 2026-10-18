import {
  AI_CONTEXT_TOKEN_BUDGET,
  AI_MAX_HISTORY_MESSAGES,
  AI_PROMPT_HISTORY_MAX_TOKENS,
  type AiAction,
  type AiSummaryScope,
  type Locator,
} from '@bookr/shared';
import { describeLocator, systemPromptFor, type PromptBook } from './prompts';
import type { AiChatMessage } from './types';

/** Marker appended by `trimToTokenBudget`; it is not part of the budget itself. */
const TRUNCATION_MARKER = '\n…（已截断）';
/** Hard character cap applied before token accounting for any book context. */
const MAX_CONTEXT_CHARS = 20_000;
/** Appended when a page has no text layer and chapter text stands in for it. */
const CHAPTER_FALLBACK_PREFIX = '（本页没有可用文字，以下为本章片段）\n';

/**
 * Estimates provider tokens without a tokenizer: CJK code points cost one
 * token, other non-whitespace characters a quarter, whitespace a tenth.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/^\s$/u.test(char)) {
      tokens += 0.1;
    } else if ((char.codePointAt(0) ?? 0) >= 0x2e80) {
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/** Sum of token estimates for every message content. */
export function estimateMessagesTokens(messages: AiChatMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

/**
 * Truncates text to the longest prefix that fits the token budget and marks
 * the cut. The marker does not consume budget, so the result may estimate
 * slightly above `budget`.
 */
export function trimToTokenBudget(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (budget <= 0) {
    return { text: '', truncated: text.length > 0 };
  }
  if (estimateTokens(text) <= budget) {
    return { text, truncated: false };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  // Never leave half of a surrogate pair at the cut.
  if (low > 0 && low < text.length) {
    const last = text.charCodeAt(low - 1);
    const next = text.charCodeAt(low);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      low -= 1;
    }
  }

  return { text: `${text.slice(0, low)}${TRUNCATION_MARKER}`, truncated: true };
}

/**
 * Keeps a `maxChars` window centered on the first occurrence of the selection
 * (its first 64 characters act as the anchor), falling back to the start of
 * the text. Only a trailing ellipsis is added, so the result is at most
 * `maxChars + 1` characters long.
 */
export function trimAroundSelection(
  text: string,
  selection: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const anchor = selection.slice(0, 64);
  const index = anchor.length > 0 ? text.indexOf(anchor) : -1;
  let start = 0;
  if (index >= 0) {
    const lead = Math.floor((maxChars - Math.min(selection.length, maxChars)) / 2);
    start = Math.max(0, index - lead);
  }

  return { text: `${text.slice(start, start + maxChars)}…`, truncated: true };
}

export interface AssemblePromptInput {
  action: AiAction;
  scope?: AiSummaryScope;
  book: PromptBook;
  locator?: Locator;
  selectedText?: string;
  question?: string;
  pageText?: string;
  chapterText?: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  contextTokenBudget?: number;
  historyTokenBudget?: number;
}

export interface AssembledPrompt {
  messages: AiChatMessage[];
  promptTokens: number;
  contextChars: number;
  truncated: boolean;
}

type ContextSection = 'page' | 'chapter' | 'none';

interface SelectedContext {
  kind: ContextSection;
  text: string;
  prefix: string;
}

/** Picks the book text that belongs in the user message for one action. */
function selectContext(
  action: AiAction,
  scope: AiSummaryScope | undefined,
  pageText: string,
  chapterText: string,
): SelectedContext {
  const hasPage = pageText.trim().length > 0;
  const hasChapter = chapterText.trim().length > 0;

  if (action === 'summarize') {
    if (scope === 'chapter') {
      return hasChapter
        ? { kind: 'chapter', text: chapterText, prefix: '' }
        : { kind: 'none', text: '', prefix: '' };
    }
    return hasPage
      ? { kind: 'page', text: pageText, prefix: '' }
      : { kind: 'none', text: '', prefix: '' };
  }

  if (hasPage) {
    return { kind: 'page', text: pageText, prefix: '' };
  }
  if (hasChapter) {
    const prefix = action === 'explain' ? CHAPTER_FALLBACK_PREFIX : '';
    return { kind: 'chapter', text: chapterText, prefix };
  }
  return { kind: 'none', text: '', prefix: '' };
}

/**
 * Replays prior messages newest-first until either the count or token cap is
 * reached, trimming the oldest accepted message to what remains, then returns
 * them in chronological order.
 */
function selectHistory(
  history: AssemblePromptInput['history'],
  tokenBudget: number,
): { messages: AiChatMessage[]; truncated: boolean } {
  const selected: AiChatMessage[] = [];
  let remaining = tokenBudget;
  let truncated = false;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (selected.length >= AI_MAX_HISTORY_MESSAGES || remaining <= 0) {
      break;
    }
    const entry = history[index]!;
    const trimmed = trimToTokenBudget(entry.content, remaining);
    remaining -= estimateTokens(trimmed.text);
    truncated ||= trimmed.truncated;
    selected.push({ role: entry.role, content: trimmed.text });
  }

  selected.reverse();
  return { messages: selected, truncated };
}

/**
 * Assembles the provider messages for one companion request: the versioned
 * system prompt, as much history as the budget allows, and a single user
 * message carrying the book metadata and trimmed reading context.
 */
export function assemblePrompt(input: AssemblePromptInput): AssembledPrompt {
  const messages: AiChatMessage[] = [
    { role: 'system', content: systemPromptFor(input.action, input.scope) },
  ];

  const history = selectHistory(
    input.history,
    input.historyTokenBudget ?? AI_PROMPT_HISTORY_MAX_TOKENS,
  );
  messages.push(...history.messages);

  const selected = selectContext(
    input.action,
    input.scope,
    input.pageText ?? '',
    input.chapterText ?? '',
  );
  const around = trimAroundSelection(
    selected.text,
    input.selectedText ?? '',
    MAX_CONTEXT_CHARS,
  );
  const budgeted = trimToTokenBudget(
    around.text,
    input.contextTokenBudget ?? AI_CONTEXT_TOKEN_BUDGET,
  );
  const contextText = `${selected.prefix}${budgeted.text}`;

  const sections = [
    `【书名】《${input.book.title}》`,
    ...(input.book.author ? [`【作者】${input.book.author}`] : []),
    `【位置】${describeLocator(input.locator)}`,
  ];
  if (selected.kind === 'page' && contextText.length > 0) {
    sections.push(`【本页文字】\n${contextText}`);
  } else if (selected.kind === 'chapter' && contextText.length > 0) {
    sections.push(`【本章文字】\n${contextText}`);
  }
  if (input.selectedText) {
    sections.push(`【选中段落】\n${input.selectedText}`);
  }
  if (input.question) {
    sections.push(`【问题】\n${input.question}`);
  }
  messages.push({ role: 'user', content: sections.join('\n') });

  return {
    messages,
    promptTokens: estimateMessagesTokens(messages),
    contextChars: contextText.length + (input.selectedText?.length ?? 0),
    truncated: history.truncated || around.truncated || budgeted.truncated,
  };
}

import {
  NOTE_ANALYSIS_TITLE_MAX_LENGTH,
  type Locator,
  type NoteAnalysisKind,
} from '@bookr/shared';
import { estimateTokens } from '../ai/context';
import type { AiChatMessage } from '../ai/types';
import { describeLocator } from '../reading/locator-label';

/** Version stamped on every stored analysis prompt. */
export const NOTE_ANALYSIS_PROMPT_VERSION = 'p6.1';
/** Tokens shared by the system prompt, header and as many notes as fit. */
export const NOTE_ANALYSIS_TOKEN_BUDGET = 24_000;
/** Output ceiling requested from the reasoner model. */
export const NOTE_ANALYSIS_MAX_OUTPUT_TOKENS = 4_096;

/** Characters kept from one highlight before an ellipsis is appended. */
const MAX_SELECTED_TEXT_CHARS = 600;
/** Characters kept from one annotation before an ellipsis is appended. */
const MAX_NOTE_TEXT_CHARS = 400;

/** One note already joined with its book metadata, ready for rendering. */
export interface AnalysisSourceNote {
  bookTitle: string;
  bookAuthor: string | null;
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  createdAt: Date;
}

const KIND_LABELS: Record<NoteAnalysisKind, string> = {
  themes: '主题归纳',
  viewpoints: '观点梳理',
  todos: '待办提取',
};

const KIND_INSTRUCTIONS: Record<NoteAnalysisKind, string> = {
  themes: [
    '请用中文 Markdown 输出「主题归纳」：',
    '1. 归纳 3–7 个主题，每个主题下列出对应的笔记编号（如 [2]）与一句话概括；',
    '2. 引用时使用书名与编号，不要复述全部原文；',
    '3. 最后用一段话指出贯穿这些主题的主线。',
  ].join('\n'),
  viewpoints: [
    '请用中文 Markdown 输出「观点梳理」：',
    '1. 区分「原文观点」与「我的批注」，分别归纳；',
    '2. 列出两者之间的分歧、值得注意的疑问，以及可以继续追问的点；',
    '3. 引用时使用书名与编号，不要复述全部原文。',
  ].join('\n'),
  todos: [
    '请用中文 Markdown 输出「待办提取」：',
    '1. 提取可执行的行动，每条包含理由与关联的笔记编号；',
    '2. 引用时使用书名与编号，不要复述全部原文；',
    '3. 如果这批笔记里没有可执行的待办，明确说「这批笔记里没有可执行的待办」。',
  ].join('\n'),
};

/** System prompt shared by all analysis kinds, with kind-specific output rules. */
export function analysisSystemPrompt(kind: NoteAnalysisKind): string {
  return [
    '你是阅读笔记分析助手，只依据下面给出的笔记回答，不要编造笔记之外的信息。',
    '笔记按阅读时间顺序编号；回答里需要提及时，用书名和编号引用。',
    KIND_INSTRUCTIONS[kind],
  ].join('\n\n');
}

/** Human-readable title shown in the analysis list. */
export function analysisTitle(kind: NoteAnalysisKind, bookTitle: string | null): string {
  const label = KIND_LABELS[kind];
  const title = bookTitle ? `《${bookTitle}》${label}` : `笔记${label}`;
  return title.slice(0, NOTE_ANALYSIS_TITLE_MAX_LENGTH);
}

/** Clips one field to its character cap, marking the cut with an ellipsis. */
function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Local calendar date (`YYYY-MM-DD`) written next to each note. */
function noteDate(createdAt: Date): string {
  return createdAt.toISOString().slice(0, 10);
}

/**
 * Renders one note block. `index` is only used for accounting before the final
 * chronological numbering is known, so pass the widest possible index there.
 */
function renderNote(note: AnalysisSourceNote, index: number): string {
  const lines = [
    `[${index}] 《${note.bookTitle}》 · ${describeLocator(note.locator)}`,
    `划线：${clip(note.selectedText, MAX_SELECTED_TEXT_CHARS)}`,
  ];
  const noteText = note.noteText?.trim();
  if (noteText) {
    lines.push(`批注：${clip(noteText, MAX_NOTE_TEXT_CHARS)}`);
  }
  if (note.tags.length > 0) {
    lines.push(`标签：${note.tags.join('、')}`);
  }
  lines.push(`时间：${noteDate(note.createdAt)}`);
  return lines.join('\n');
}

/** Header plus body shared by the selection pass and the final prompt. */
function renderAnalysisContent(
  total: number,
  analyzedCount: number,
  chronological: AnalysisSourceNote[],
): string {
  const header = [
    `共 ${total} 条笔记，以下按阅读时间顺序列出 ${analyzedCount} 条。`,
    ...(analyzedCount < total ? ['较早的其余笔记因篇幅未列入。'] : []),
  ].join('\n');
  const blocks = chronological.map((note, position) => renderNote(note, position + 1));
  return [header, ...blocks].join('\n\n');
}

/**
 * Selects as many of the newest notes as the token budget allows, then renders
 * them in chronological order so `[1]` is always the oldest included note.
 */
export function buildAnalysisPrompt(input: {
  kind: NoteAnalysisKind;
  notes: AnalysisSourceNote[]; // newest first
  total: number;
}): { messages: AiChatMessage[]; promptTokens: number; analyzedCount: number } {
  const system = analysisSystemPrompt(input.kind);
  // Reserve three index digits (the cap is 300 notes) so the selection pass
  // never under-counts the header or the final numbering.
  const widestIndex = 300;
  const headerReserve =
    `共 ${input.total} 条笔记，以下按阅读时间顺序列出 ${widestIndex} 条。\n` +
    '较早的其余笔记因篇幅未列入。';
  const reserve = estimateTokens(system) + estimateTokens(headerReserve);

  let used = reserve;
  const selected: AnalysisSourceNote[] = []; // newest first
  for (const note of input.notes) {
    const blockTokens = estimateTokens(`${renderNote(note, widestIndex)}\n\n`);
    if (used + blockTokens > NOTE_ANALYSIS_TOKEN_BUDGET) {
      break;
    }
    used += blockTokens;
    selected.push(note);
  }

  const chronological = [...selected].reverse();
  const content = renderAnalysisContent(input.total, chronological.length, chronological);
  const messages: AiChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content },
  ];

  return {
    messages,
    promptTokens: messages.reduce(
      (sum, message) => sum + estimateTokens(message.content),
      0,
    ),
    analyzedCount: chronological.length,
  };
}

import type { AiAction, AiSummaryScope, Locator } from '@bookr/shared';

/** Version tag recorded with every AI request so prompt changes stay auditable. */
export const PROMPT_VERSION = 'p5.1';

/** Minimal book metadata used to introduce the reading material. */
export interface PromptBook {
  title: string;
  author: string | null;
}

/**
 * Shared rules. Every action keeps the same grounding contract so the model
 * never invents text that was not supplied with the request.
 */
const BASE_RULES = [
  '你是「纸墨书房」的阅读伴读。',
  '只依据本次提供的书名、位置、选中段落与本页/本章文字回答；材料不足时直接说明缺少什么，不得编造原文未出现的事实；引用原文用「」；不确定的一般知识必须标注『以下为一般知识』。',
].join('\n');

const ACTION_INSTRUCTIONS = {
  explain: '用通俗语言解释选中段落，先给一句话结论，再分点说明关键词与逻辑，控制在 400 字内。',
  'summarize/page': '总结当前页的主要信息，用 3–6 条要点，不引入本页没有的内容。',
  'summarize/chapter': '总结当前章的主要信息，用 3–6 条要点，不引入本章没有的内容。',
  ask: '回答用户的问题；优先引用上下文，必要时说明上下文不足。',
} as const;

type ActionInstructionKey = keyof typeof ACTION_INSTRUCTIONS;

/** Returns the versioned system prompt for one action and summary scope. */
export function systemPromptFor(action: AiAction, scope?: AiSummaryScope): string {
  const key: ActionInstructionKey =
    action === 'summarize' ? `summarize/${scope ?? 'page'}` : action;
  return `${BASE_RULES}\n${ACTION_INSTRUCTIONS[key]}`;
}

/** Human-readable Chinese label for a reading location. */
export function describeLocator(locator: Locator | undefined): string {
  if (!locator) {
    return '未提供位置';
  }

  let label: string;
  switch (locator.kind) {
    case 'pdf':
      label = `第 ${locator.page} 页`;
      break;
    case 'reflow':
      label = `源页 ${locator.sourcePage}`;
      break;
    case 'epub':
      label = `进度 ${Math.round(locator.percent * 100)}%`;
      break;
  }

  if (typeof locator.percent === 'number') {
    label += `（全书 ${Math.round(locator.percent * 100)}%）`;
  }
  return label;
}

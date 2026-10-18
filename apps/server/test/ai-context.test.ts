import { describe, expect, it } from 'vitest';
import { AI_CONTEXT_TOKEN_BUDGET, AI_MAX_HISTORY_MESSAGES } from '@bookr/shared';
import {
  assemblePrompt,
  estimateTokens,
  trimAroundSelection,
  trimToTokenBudget,
} from '../src/ai/context';
import { PROMPT_VERSION, describeLocator, systemPromptFor } from '../src/ai/prompts';

const book = { title: '深入理解计算机系统', author: 'Bryant' };
const locator = { kind: 'pdf' as const, page: 12, percent: 0.4 };

it('estimates CJK and ASCII tokens deterministically', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('你好世界')).toBe(4);
  expect(estimateTokens('hello')).toBe(2);
  expect(estimateTokens('你好 world')).toBe(4);
});

it('trims context to the token budget with a marker', () => {
  const trimmed = trimToTokenBudget('字'.repeat(1000), 100);
  expect(trimmed.truncated).toBe(true);
  expect(trimmed.text.startsWith('字'.repeat(100))).toBe(true);
  expect(trimmed.text).toContain('已截断');
});

it('keeps a window around the selection', () => {
  const text = `${'前'.repeat(100)}选中文字${'后'.repeat(100)}`;
  const trimmed = trimAroundSelection(text, '选中文字', 60);
  expect(trimmed.truncated).toBe(true);
  expect(trimmed.text).toContain('选中文字');
  expect(trimmed.text.length).toBeLessThanOrEqual(61);
});

it('includes book, location, page and selection in the explain prompt', () => {
  const result = assemblePrompt({
    action: 'explain', book, locator,
    selectedText: '程序如何运行',
    pageText: '本页正文第一段。',
    history: [],
  });
  const last = result.messages.at(-1)!.content;
  expect(last).toContain('深入理解计算机系统');
  expect(last).toContain('第 12 页');
  expect(last).toContain('本页正文第一段');
  expect(last).toContain('程序如何运行');
  expect(result.messages[0]!.role).toBe('system');
  expect(result.promptTokens).toBeGreaterThan(0);
  expect(systemPromptFor('explain')).toContain('不得编造');
});

it('falls back to chapter text when the page has no text layer', () => {
  const result = assemblePrompt({
    action: 'explain', book,
    selectedText: '扫描页上的文字',
    pageText: '', chapterText: '本章正文。',
    history: [],
  });
  expect(result.messages.at(-1)!.content).toContain('本页没有可用文字');
  expect(result.messages.at(-1)!.content).toContain('本章正文');
});

it('uses only the requested scope for summaries', () => {
  const page = assemblePrompt({
    action: 'summarize', scope: 'page', book,
    pageText: '本页内容', chapterText: '本章内容', history: [],
  });
  expect(page.messages.at(-1)!.content).toContain('本页内容');
  expect(page.messages.at(-1)!.content).not.toContain('本章内容');

  const chapter = assemblePrompt({
    action: 'summarize', scope: 'chapter', book,
    pageText: '本页内容', chapterText: '本章内容', history: [],
  });
  expect(chapter.messages.at(-1)!.content).toContain('本章内容');
});

it('caps history by count and tokens and keeps chronological order', () => {
  const history = Array.from({ length: AI_MAX_HISTORY_MESSAGES + 5 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `第${index}条 ${'长'.repeat(3000)}`,
  }));
  const result = assemblePrompt({
    action: 'ask', book, question: '现在呢？', pageText: '本页', history,
  });
  const contents = result.messages.map((message) => message.content);
  expect(contents.some((content) => content.includes(`第${history.length - 1}条`))).toBe(true);
  expect(contents.some((content) => content.includes('第0条'))).toBe(false);
  expect(result.promptTokens).toBeLessThan(AI_CONTEXT_TOKEN_BUDGET + 3_000);
});

it('renders a stable prompt version and locator labels', () => {
  expect(PROMPT_VERSION).toBe('p5.1');
  expect(describeLocator(locator)).toBe('第 12 页（全书 40%）');
  expect(describeLocator({ kind: 'reflow', sourcePage: 7, percent: 0.5 })).toBe(
    '源页 7（全书 50%）',
  );
  expect(describeLocator({ kind: 'epub', cfi: 'epubcfi(/6/4!/4/2)', percent: 0.42 })).toBe(
    '全书 42%',
  );
  expect(describeLocator(undefined)).toBe('未提供位置');
});

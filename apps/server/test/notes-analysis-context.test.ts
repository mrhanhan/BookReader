import { expect, it } from 'vitest';
import { estimateTokens } from '../src/ai/context';
import {
  analysisSystemPrompt,
  analysisTitle,
  buildAnalysisPrompt,
  NOTE_ANALYSIS_TOKEN_BUDGET,
  type AnalysisSourceNote,
} from '../src/notes/analysis-context';

function makeNote(selectedText: string, date: string): AnalysisSourceNote {
  return {
    bookTitle: '深入理解计算机系统',
    bookAuthor: 'Bryant',
    locator: { kind: 'pdf', page: 12, percent: 0.4 },
    selectedText,
    noteText: null,
    tags: [],
    updatedAt: new Date(`${date}T00:00:00Z`),
  };
}

function userContent(messages: Array<{ role: string; content: string }>): string {
  return messages.find((message) => message.role === 'user')!.content;
}

it('numbers notes chronologically and reports the analyzed count', () => {
  const prompt = buildAnalysisPrompt({
    kind: 'themes',
    notes: [
      makeNote('最新的划线', '2026-10-03'),
      makeNote('中间的划线', '2026-10-02'),
      makeNote('最早的划线', '2026-10-01'),
    ],
    total: 3,
    timezone: 'Asia/Shanghai',
  });

  expect(prompt.analyzedCount).toBe(3);
  expect(prompt.promptTokens).toBeGreaterThan(0);

  const content = userContent(prompt.messages);
  expect(content).toContain('共 3 条笔记，以下按最近编辑时间顺序列出 3 条。');

  const first = content.indexOf('[1]');
  const second = content.indexOf('[2]');
  const third = content.indexOf('[3]');
  expect(content.slice(first, second)).toContain('最早的划线');
  expect(content.slice(second, third)).toContain('中间的划线');
  expect(content.slice(third)).toContain('最新的划线');
});

it('drops the oldest notes when the token budget is exceeded', () => {
  const notes = Array.from({ length: 60 }, (_value, index) => {
    const day = new Date(Date.UTC(2026, 9, 20) - index * 86_400_000).toISOString().slice(0, 10);
    return makeNote(`第${index}条${'长'.repeat(1_500)}`, day);
  });

  const prompt = buildAnalysisPrompt({
    kind: 'themes',
    notes,
    total: notes.length,
    timezone: 'UTC',
  });

  expect(prompt.analyzedCount).toBeLessThan(notes.length);
  expect(prompt.analyzedCount).toBeGreaterThan(0);
  expect(userContent(prompt.messages)).toContain('较早的其余笔记因篇幅未列入。');

  const totalTokens = prompt.messages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  );
  expect(totalTokens).toBeLessThanOrEqual(NOTE_ANALYSIS_TOKEN_BUDGET + 400);
});

it('formats each note date in the reader timezone', () => {
  const note = {
    ...makeNote('时区测试', '2026-10-18'),
    updatedAt: new Date('2026-10-18T17:00:00Z'),
  };

  const shanghai = buildAnalysisPrompt({
    kind: 'themes',
    notes: [note],
    total: 1,
    timezone: 'Asia/Shanghai',
  });
  expect(userContent(shanghai.messages)).toContain('时间：2026-10-19');

  // An unknown zone falls back to UTC.
  const fallback = buildAnalysisPrompt({
    kind: 'themes',
    notes: [note],
    total: 1,
    timezone: 'Not/AZone',
  });
  expect(userContent(fallback.messages)).toContain('时间：2026-10-18');
});

it('asks for the right output per kind', () => {
  const themes = analysisSystemPrompt('themes');
  expect(themes).toContain('主题归纳');

  const viewpoints = analysisSystemPrompt('viewpoints');
  expect(viewpoints).toContain('原文观点');
  expect(viewpoints).toContain('我的批注');

  expect(analysisSystemPrompt('todos')).toContain('待办');

  for (const kind of ['themes', 'viewpoints', 'todos'] as const) {
    expect(analysisSystemPrompt(kind)).toContain('只依据');
  }
});

it('builds a bounded title', () => {
  expect(analysisTitle('themes', '一本书'.repeat(60))).toHaveLength(80);
  expect(analysisTitle('themes', '深入理解计算机系统')).toBe('《深入理解计算机系统》主题归纳');
  expect(analysisTitle('themes', null)).toBe('笔记主题归纳');
});

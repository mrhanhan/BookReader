import { describe, expect, it } from 'vitest';
import {
  AI_MAX_QUESTION_LENGTH,
  aiChatRequestSchema,
} from '../ai';

const locator = { kind: 'pdf', page: 12, percent: 0.4 };

describe('AI contract', () => {
  it('accepts an explain request with page context', () => {
    const parsed = aiChatRequestSchema.safeParse({
      action: 'explain',
      selectedText: '晦涩的段落',
      locator,
      context: { pageText: '本页正文' },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires selectedText for explain', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'explain' }).success).toBe(false);
  });

  it('requires a question for ask and caps its length', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'ask' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'ask',
        question: 'x'.repeat(AI_MAX_QUESTION_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(aiChatRequestSchema.safeParse({ action: 'ask', question: '为什么？' }).success).toBe(true);
  });

  it('requires the matching context for each summarize scope', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'summarize', scope: 'page' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize', scope: 'page', context: { chapterText: '章' },
      }).success,
    ).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize', scope: 'chapter', context: { chapterText: '章' },
      }).success,
    ).toBe(true);
  });

  it('rejects unknown actions and oversized context', () => {
    expect(aiChatRequestSchema.safeParse({ action: 'rewrite' }).success).toBe(false);
    expect(
      aiChatRequestSchema.safeParse({
        action: 'summarize',
        scope: 'chapter',
        context: { chapterText: 'x'.repeat(60_001) },
      }).success,
    ).toBe(false);
  });

  it('accepts a follow-up thread id', () => {
    expect(
      aiChatRequestSchema.safeParse({
        action: 'ask',
        question: '再展开一点',
        threadId: '01a14f19-c2e6-73c7-a934-733f788451cf',
      }).success,
    ).toBe(true);
  });
});

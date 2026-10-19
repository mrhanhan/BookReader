import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { annotations, type AnnotationRow } from '../src/db/schema';
import { buildNotesMarkdown } from '../src/notes/export';
import type { NoteQueryRow } from '../src/notes/repo';
import {
  authHeader,
  createTestApp,
  resetDb,
  seedAnnotation,
  seedBook,
  seedUser,
  testDb,
  type SeedAnnotationInput,
} from './helpers';

const FIXED_NOW = new Date('2026-10-19T02:00:00Z');

/** Joins a test app with a frozen clock so generated dates are deterministic. */
async function fixedApp() {
  const { app, deps } = await createTestApp();
  deps.clock = { now: () => FIXED_NOW };
  return app;
}

/** Seeds an annotation, then pins its creation time (the shared helper cannot). */
async function seedNote(
  input: SeedAnnotationInput & { createdAt?: Date },
): Promise<AnnotationRow> {
  const row = await seedAnnotation(input);
  if (!input.createdAt) {
    return row;
  }
  await testDb
    .update(annotations)
    .set({ createdAt: input.createdAt })
    .where(eq(annotations.id, row.id));
  return { ...row, createdAt: input.createdAt };
}

function noteRow(overrides: Partial<AnnotationRow> = {}): NoteQueryRow {
  return {
    annotation: {
      id: newId(),
      userId: 'user-id',
      bookId: 'book-id',
      type: 'highlight',
      color: 'yellow',
      locator: { kind: 'pdf', page: 1, percent: 0 },
      selectedText: '原文',
      noteText: null,
      tags: [],
      revision: 1,
      deletedAt: null,
      createdAt: new Date('2026-10-18T00:00:00Z'),
      updatedAt: new Date('2026-10-18T00:00:00Z'),
      clientUpdatedAt: null,
      ...overrides,
    },
    book: { id: 'book-id', title: '书名', author: null, format: 'pdf' },
  };
}

it('exports grouped Markdown with book, position, quote, note, tags and date', async () => {
  await resetDb();
  const app = await fixedApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({
    uploadedBy: alice.id,
    title: '深入理解计算机系统',
    author: 'Randal E. Bryant',
  });
  await seedNote({
    userId: alice.id,
    bookId: book.id,
    type: 'highlight',
    locator: { kind: 'pdf', page: 12, percent: 0.4 },
    selectedText: '原文第一行\n原文第二行',
    noteText: '批注文字',
    tags: ['历史', '方法论'],
    // The date line shows when the note was written, not when it was edited.
    createdAt: new Date('2026-10-18T12:00:00Z'),
    updatedAt: new Date('2026-10-19T12:00:00Z'),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/notes/export',
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toContain('text/markdown');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toBe(
    [
      '# 笔记库',
      '',
      '导出时间：2026-10-19',
      '共 1 条笔记',
      '',
      '## 《深入理解计算机系统》 · Randal E. Bryant',
      '',
      '### 第 12 页（全书 40%）',
      '',
      '> 原文第一行',
      '> 原文第二行',
      '',
      '批注文字',
      '',
      '标签：#历史 #方法论',
      '',
      '*2026-10-18*',
      '',
    ].join('\n'),
  );
});

it('applies filters and excludes other members and trashed books', async () => {
  await resetDb();
  const app = await fixedApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const target = await seedBook({ uploadedBy: alice.id, title: '过滤之书' });
  const other = await seedBook({ uploadedBy: alice.id, title: '另一本书' });
  const trashed = await seedBook({
    uploadedBy: alice.id,
    title: '回收站之书',
    deletedAt: new Date('2026-10-01T00:00:00Z'),
  });

  const kept = await seedAnnotation({
    userId: alice.id,
    bookId: target.id,
    selectedText: '命中关键词的划线',
    noteText: '保留的批注',
    tags: ['筛选'],
  });
  await seedAnnotation({
    userId: alice.id,
    bookId: target.id,
    selectedText: '命中关键词但标签不符',
    tags: ['其他'],
  });
  await seedAnnotation({
    userId: alice.id,
    bookId: other.id,
    selectedText: '命中关键词但在另一本书',
    tags: ['筛选'],
  });
  await seedAnnotation({
    userId: bob.id,
    bookId: target.id,
    selectedText: '命中关键词但属于别人',
    tags: ['筛选'],
  });
  await seedAnnotation({
    userId: alice.id,
    bookId: trashed.id,
    selectedText: '命中关键词但在回收站',
    tags: ['筛选'],
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/notes/export?bookId=${target.id}&tag=${encodeURIComponent('筛选')}&q=${encodeURIComponent('命中关键词')}`,
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  expect(response.body).toContain(`共 1 条笔记`);
  expect(response.body).toContain('## 《过滤之书》');
  expect(response.body).toContain(kept.selectedText);
  expect(response.body).toContain('保留的批注');
  expect(response.body).not.toContain('标签不符');
  expect(response.body).not.toContain('另一本书');
  expect(response.body).not.toContain('属于别人');
  expect(response.body).not.toContain('回收站之书');
});

it('groups notes from the same book under one heading in creation order', async () => {
  await resetDb();
  const app = await fixedApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({ uploadedBy: alice.id, title: '同一本书', author: '作者乙' });
  const first = await seedNote({
    userId: alice.id,
    bookId: book.id,
    locator: { kind: 'pdf', page: 3, percent: 0.1 },
    selectedText: '先创建的划线',
    tags: ['历史'],
    createdAt: new Date('2026-10-10T04:00:00Z'),
    // Deliberately newer than the second note's edit, so an updatedAt sort
    // would reverse the expected creation order.
    updatedAt: new Date('2026-10-22T04:00:00Z'),
  });
  const second = await seedNote({
    userId: alice.id,
    bookId: book.id,
    locator: { kind: 'pdf', page: 8, percent: 0.5 },
    selectedText: '后创建的划线',
    tags: ['历史'],
    createdAt: new Date('2026-10-12T04:00:00Z'),
    updatedAt: new Date('2026-10-21T04:00:00Z'),
  });
  expect(first.createdAt.getTime()).toBeLessThan(second.createdAt.getTime());

  const response = await app.inject({
    method: 'GET',
    url: '/api/notes/export',
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  const body = response.body;
  expect(body.match(/^## /gm)).toHaveLength(1);
  expect(body.match(/^## 《同一本书》 · 作者乙$/gm)).toHaveLength(1);
  const positions = body.match(/^### .*$/gm);
  expect(positions).toHaveLength(2);
  expect(positions).toEqual(['### 第 3 页（全书 10%）', '### 第 8 页（全书 50%）']);
  expect(body.indexOf(first.selectedText)).toBeGreaterThan(-1);
  expect(body.indexOf(first.selectedText)).toBeLessThan(body.indexOf(second.selectedText));
  expect(body.match(/^---$/gm)).toHaveLength(1);
  // Dates come from createdAt, not updatedAt.
  expect(body).toContain('*2026-10-10*');
  expect(body).toContain('*2026-10-12*');
  expect(body.indexOf('*2026-10-10*')).toBeLessThan(body.indexOf('*2026-10-12*'));
  expect(body).not.toContain('2026-10-20');
  expect(body).not.toContain('2026-10-21');
  expect(body).not.toContain('2026-10-22');
});

it('caps the export and says so', () => {
  const markdown = buildNotesMarkdown({
    notes: [
      noteRow({
        selectedText: '原文第一行\n\n原文第三行',
        noteText: null,
        tags: ['历史'],
      }),
      noteRow({ selectedText: '第二条划线' }),
    ],
    total: 6000,
    truncated: true,
    generatedAt: FIXED_NOW,
    timezone: 'Asia/Shanghai',
  });

  expect(markdown).toContain('共 6000 条笔记\n仅导出前 5000 条（按书名与阅读时间排序）。');
  // Blank source lines become a bare `>` so the quote block never breaks.
  expect(markdown).toContain('> 原文第一行\n>\n> 原文第三行');
  // Both note rows default to the same book, so the heading appears once.
  expect(markdown.match(/^## 《书名》$/gm)).toHaveLength(1);
  expect(markdown.match(/^---$/gm)).toHaveLength(1);
  expect(markdown.endsWith('*2026-10-18*\n')).toBe(true);
});

it('escapes markdown-significant note lines and collapses the book title', () => {
  const row = noteRow({
    noteText: '## 伪造书名\n---\n* 列表\n> 引用\n```js\n~~~\n===\n代码',
    tags: ['换\n行', '   '],
  });
  row.book = { id: 'book-id', title: '第一行\n第二行', author: '作者', format: 'pdf' };

  const markdown = buildNotesMarkdown({
    notes: [row],
    total: 1,
    truncated: false,
    generatedAt: FIXED_NOW,
    timezone: 'Asia/Shanghai',
  });

  expect(markdown.match(/^## /gm)).toHaveLength(1);
  expect(markdown).toContain('## 《第一行 第二行》 · 作者');
  expect(markdown).toContain('\\## 伪造书名');
  expect(markdown).toContain('\\---');
  expect(markdown).toContain('\\* 列表');
  expect(markdown).toContain('\\> 引用');
  expect(markdown).not.toContain('\n## 伪造书名');
  expect(markdown).toContain('\\```js');
  expect(markdown).toContain('\\~~~');
  expect(markdown).toContain('\\===');
  // A tag with an embedded newline cannot split the tag line; whitespace tags
  // disappear instead of leaving an empty label.
  expect(markdown).toContain('标签：#换 行');
});

it('sets a UTF-8 filename in content-disposition', async () => {
  await resetDb();
  const app = await fixedApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({
    uploadedBy: alice.id,
    title: '深入 理解/系统',
    author: null,
  });
  await seedAnnotation({
    userId: alice.id,
    bookId: book.id,
    selectedText: '任意划线',
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/notes/export?bookId=${book.id}`,
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  const header = String(response.headers['content-disposition']);
  expect(header).toContain('attachment');
  expect(header).toContain('filename="notes-2026-10-19.md"');

  const extended = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  expect(extended).toBeDefined();
  expect(decodeURIComponent(extended!)).toBe('笔记-深入 理解_系统-20261019.md');
  expect(extended).not.toMatch(/['()*]/);
});

it('requires authentication', async () => {
  await resetDb();
  const app = await fixedApp();
  const response = await app.inject({ method: 'GET', url: '/api/notes/export' });
  expect(response.statusCode).toBe(401);
});

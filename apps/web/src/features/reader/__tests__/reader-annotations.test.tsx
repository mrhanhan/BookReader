import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { server } from '../../../../test/setup';
import {
  createFakeSyncEngine,
  createMemoryRepository,
  type FakeSyncEngine,
  type MemoryRepository,
} from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';
const USER = 'user-reader';

const pdfFile = () =>
  HttpResponse.json({
    url: 'https://files.test/book.pdf',
    format: 'pdf',
    expiresIn: 3600,
  });

const seededNote = {
  id: 'n1',
  bookId: BOOK_ID,
  type: 'note' as const,
  color: 'blue' as const,
  locator: { kind: 'pdf' as const, page: 4, percent: 0.3 },
  selectedText: '原文',
  noteText: '我的批注',
  tags: ['历史'],
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const seededHighlight = {
  id: 'h1',
  bookId: BOOK_ID,
  type: 'highlight' as const,
  color: 'yellow' as const,
  locator: { kind: 'pdf' as const, page: 3, percent: 0.25 },
  selectedText: '一段原文',
  noteText: null,
  tags: ['重点'],
  revision: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function renderReader(engine: FakeReaderEngine = createFakeEngine()) {
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  server.use(http.get(`/api/books/${BOOK_ID}/file`, pdfFile));
  const view = renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  return { engine, ...view };
}

function seedNote(): void {
  repo.seedAnnotation(USER, seededNote);
}

function seedHighlight(
  overrides: Partial<Omit<typeof seededHighlight, 'noteText'>> & { noteText?: string | null } = {},
): void {
  repo.seedAnnotation(USER, { ...seededHighlight, ...overrides });
}

it('creates a highlight from a text selection and renders it in the engine', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '被选中的原文',
    locator: {
      kind: 'pdf',
      page: 2,
      percent: 0.2,
      rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.03 },
    },
    rect: { left: 10, top: 20, width: 100, height: 18 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '用黄色划线' }));

  await waitFor(async () => {
    const rows = await repo.listAnnotations(USER, BOOK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'highlight',
      color: 'yellow',
      selectedText: '被选中的原文',
      dirty: true,
    });
  });
  expect(repo.outbox.some((row) => row.entityType === 'annotation' && row.op === 'upsert')).toBe(
    true,
  );
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ color: 'yellow', hasNote: false }),
    ]),
  );
});

it('creates a note with text and jumps back from the notes panel', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  seedNote();
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await userEvent.click(await screen.findByText('我的批注'));
  expect(engine.goTo).toHaveBeenCalledWith({ kind: 'pdf', page: 4, percent: 0.3 }, { flash: true });
});

it('creates a note from the selection menu with the chosen color and normalized tags', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '需要注释的原文',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '写批注' }));
  await userEvent.click(screen.getByRole('button', { name: '颜色：蓝色' }));
  await userEvent.type(screen.getByLabelText('批注内容'), '我的想法');
  await userEvent.type(screen.getByLabelText('标签（用逗号分隔）'), '历史， 文学,历史');
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(async () => {
    const rows = await repo.listAnnotations(USER, BOOK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'note',
      color: 'blue',
      noteText: '我的想法',
      tags: ['历史', '文学'],
      selectedText: '需要注释的原文',
    });
  });
});

it('copies the selection and shows a confirmation toast', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '要复制的段落',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await user.click(await screen.findByRole('button', { name: '复制' }));

  expect(writeText).toHaveBeenCalledWith('要复制的段落');
  expect(await screen.findByText('已复制')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '用黄色划线' })).not.toBeInTheDocument();
  writeText.mockRestore();
});

it('recolors a pure highlight without writing a blank note', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  seedHighlight();
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'h1', color: 'yellow', hasNote: false }),
    ]),
  );

  engine.emit('highlightClick', { id: 'h1' });
  expect(await screen.findByLabelText('批注内容')).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: '颜色：绿色' }));
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(async () => {
    const row = await repo.listAnnotations(USER, BOOK_ID);
    expect(row[0]).toMatchObject({ color: 'green', noteText: null, tags: ['重点'] });
  });
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'h1', color: 'green', hasNote: false }),
    ]),
  );
});

it('clears a highlight note when the text is emptied', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  seedHighlight({ noteText: '旧批注' });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'h1', hasNote: true }),
    ]),
  );

  engine.emit('highlightClick', { id: 'h1' });
  // The shared Dialog applies the native `open` attribute in an effect; wait
  // for it before interacting, otherwise a loaded machine can race the effect
  // and user-event refuses to focus the still-hidden textarea.
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(dialog).toHaveAttribute('open'));
  const textarea = await screen.findByLabelText('批注内容');
  expect(textarea).toHaveValue('旧批注');
  fireEvent.change(textarea, { target: { value: '' } });
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(async () => {
    const rows = await repo.listAnnotations(USER, BOOK_ID);
    expect(rows[0]).toMatchObject({ noteText: null });
  });
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'h1', hasNote: false }),
    ]),
  );
});

it('shows a conflict toast when the sync engine reports one', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  syncEngine.setState({ status: 'synced', pending: 0, lastSyncedAt: null, conflicts: 1 });

  expect(
    await screen.findByText('此批注已在另一台设备更新，旧版本已保留在历史中'),
  ).toBeInTheDocument();
});

it('deletes an annotation after confirmation', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  seedNote();
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await screen.findByText('我的批注');
  await userEvent.click(screen.getByRole('button', { name: /^删除：/ }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

  await waitFor(async () => {
    expect(await repo.listAnnotations(USER, BOOK_ID)).toEqual([]);
  });
  expect(repo.outbox.some((row) => row.entityType === 'annotation' && row.op === 'delete')).toBe(
    true,
  );
  await waitFor(() =>
    expect(screen.queryByTestId('annotation-item')).not.toBeInTheDocument(),
  );
  expect(await screen.findByText('还没有划线和批注')).toBeInTheDocument();
});

it('dismisses the selection menu on outside input, Escape or a cleared selection', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const selection = {
    text: '待处理的选中文本',
    locator: { kind: 'pdf' as const, page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  };
  const yellow = () => screen.queryByRole('button', { name: '用黄色划线' });

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  engine.emit('selection', null);
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());
});

it('keeps the open dialog and panel stable while reader shortcuts fire', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  seedNote();
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await screen.findByText('我的批注');
  engine.emit('highlightClick', { id: 'n1' });
  expect(await screen.findByLabelText('批注内容')).toBeInTheDocument();

  // Selections made under a modal are ignored.
  engine.emit('selection', {
    text: '对话框下的选中文本',
    locator: { kind: 'pdf', page: 4, percent: 0.3 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  expect(screen.queryByRole('button', { name: '用黄色划线' })).not.toBeInTheDocument();

  // `b` must not queue a bookmark dialog over the in-progress edit.
  await userEvent.keyboard('b');
  expect(screen.queryByLabelText('书签备注')).not.toBeInTheDocument();
  expect(screen.getByLabelText('批注内容')).toBeInTheDocument();

  // Escape belongs to the dialog, so the notes panel behind it stays open.
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('heading', { name: '笔记' })).toBeInTheDocument();
  expect(screen.getByLabelText('批注内容')).toBeInTheDocument();
});

it('creates a highlight while offline and queues it for sync', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  syncEngine.setState({ status: 'offline', pending: 0, lastSyncedAt: null, conflicts: 0 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '离线时划的线',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '用绿色划线' }));

  await waitFor(async () => {
    const rows = await repo.listAnnotations(USER, BOOK_ID);
    expect(rows[0]).toMatchObject({ color: 'green', selectedText: '离线时划的线' });
  });
  expect(screen.queryByRole('button', { name: '用绿色划线' })).not.toBeInTheDocument();
  expect(repo.outbox.some((row) => row.entityType === 'annotation')).toBe(true);
});

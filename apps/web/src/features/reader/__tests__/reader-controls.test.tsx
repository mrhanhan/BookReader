import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';

async function renderReader() {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
  );
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  // The chrome only renders once `open` resolves; wait for that before acting.
  await screen.findByRole('button', { name: '目录' });
  return engine;
}

/** Restores a property descriptor (or removes an own property) after mocking. */
function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

it('applies and persists theme, zoom and font changes', async () => {
  const engine = await renderReader();
  await userEvent.click(screen.getByRole('button', { name: '设置' }));
  await userEvent.click(screen.getByRole('button', { name: '深色主题' }));
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ theme: 'dark' }),
  );
  expect(JSON.parse(localStorage.getItem('bookr.reader.settings.v1')!)).toMatchObject({
    theme: 'dark',
  });

  await userEvent.selectOptions(screen.getByLabelText('缩放'), 'fit-page');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 'fit-page' }) }),
  );

  await userEvent.click(screen.getByLabelText('自动裁边'));
  await userEvent.clear(screen.getByLabelText('裁边上边'));
  await userEvent.type(screen.getByLabelText('裁边上边'), '5');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      pdf: expect.objectContaining({
        crop: 'none',
        cropAdjust: expect.objectContaining({ top: 5 }),
      }),
    }),
  );
});

it('navigates with keyboard and jumps with the progress slider', async () => {
  const engine = await renderReader();
  await userEvent.keyboard('{ArrowRight}');
  expect(engine.next).toHaveBeenCalled();
  await userEvent.keyboard('{ArrowLeft}');
  expect(engine.previous).toHaveBeenCalled();

  const slider = screen.getByLabelText('阅读进度');
  fireEvent.change(slider, { target: { value: '50' } });
  expect(engine.goToPercent).toHaveBeenLastCalledWith(0.5);

  await userEvent.clear(screen.getByLabelText('页码'));
  await userEvent.type(screen.getByLabelText('页码'), '7{Enter}');
  expect(engine.goTo).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: 'pdf', page: 7 }),
  );
});

it('hides the chrome after inactivity and reveals it on a center tap', async () => {
  await renderReader();
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2600));
  });
  expect(screen.queryByRole('button', { name: '目录' })).toBeNull();
  await userEvent.click(screen.getByTestId('reader-content'));
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
});

it('requests and exits fullscreen through the document APIs', async () => {
  await renderReader();

  const originalRequest = Object.getOwnPropertyDescriptor(
    document.documentElement,
    'requestFullscreen',
  );
  const originalExit = Object.getOwnPropertyDescriptor(document, 'exitFullscreen');
  const originalElement = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
  const requestFullscreen = vi.fn(() => Promise.resolve());
  const exitFullscreen = vi.fn(() => Promise.resolve());

  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: null,
  });

  try {
    await userEvent.click(screen.getByRole('button', { name: '全屏' }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(exitFullscreen).not.toHaveBeenCalled();

    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    });
    await userEvent.click(screen.getByRole('button', { name: '全屏' }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  } finally {
    restoreProperty(document.documentElement, 'requestFullscreen', originalRequest);
    restoreProperty(document, 'exitFullscreen', originalExit);
    restoreProperty(document, 'fullscreenElement', originalElement);
  }
});

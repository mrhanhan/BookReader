import type { ReactElement } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { RenderResult } from '@testing-library/react';
import { SyncProvider } from '../src/sync/SyncProvider';
import type { SyncEngine } from '../src/sync/engine';
import type { LocalRepository } from '../src/sync/repository';
import { renderWithProviders } from './setup';

/**
 * Renders the reader (or any consumer) with a SyncProvider backed by a test
 * repository and a controllable fake engine.
 */
export function renderWithSync(
  ui: ReactElement,
  options: { repo: LocalRepository; engine: SyncEngine },
): RenderResult & { queryClient: QueryClient } {
  return renderWithProviders(
    <SyncProvider createRepo={() => options.repo} createEngine={() => options.engine}>
      {ui}
    </SyncProvider>,
  );
}

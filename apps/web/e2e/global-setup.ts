import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { request } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8180';
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';
const fixturesScript = fileURLToPath(
  new URL('../scripts/make-reader-fixtures.mjs', import.meta.url),
);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The suite registers users, uploads books and soft-deletes data, so an
 * accidental `E2E_BASE_URL` pointing at a real deployment must fail loudly
 * before any test touches it.
 */
function assertDisposableTarget(target: string): void {
  let hostname: string;
  try {
    hostname = new URL(target).hostname;
  } catch {
    throw new Error(`E2E_BASE_URL is not a valid URL: ${target}`);
  }

  if (!LOCAL_HOSTS.has(hostname) && process.env.E2E_ALLOW_REMOTE !== '1') {
    throw new Error(
      `Refusing to run the destructive E2E suite against ${target}: it creates users and books ` +
        'and soft-deletes data. Run it against the local Docker Compose stack, or set ' +
        'E2E_ALLOW_REMOTE=1 only when the target is a disposable test environment. ' +
        'Never run it against production.',
    );
  }
}

/**
 * The reader spec uploads generated books; regenerating them keeps the binary
 * fixtures out of git and guarantees every run uses the current generator.
 */
function generateReaderFixtures(): void {
  execFileSync(process.execPath, [fixturesScript], { stdio: 'inherit' });
}

/**
 * The suite needs an existing administrator to mint invites. Registration is
 * admin-only by design (and `create-admin` refuses once any user exists), so a
 * missing admin is an environment problem the operator must fix, not
 * something the test may paper over.
 */
export default async function globalSetup(): Promise<void> {
  assertDisposableTarget(baseURL);
  generateReaderFixtures();

  const context = await request.newContext({ baseURL });
  try {
    const response = await context.post('/api/auth/login', {
      data: { username: adminUsername, password: adminPassword },
    });

    if (!response.ok()) {
      const body = await response.text();
      throw new Error(
        `E2E admin login failed for "${adminUsername}" at ${baseURL} ` +
          `(HTTP ${response.status()}): ${body.slice(0, 300)}. ` +
          'Bootstrap an administrator first with ' +
          '`docker compose exec server node dist/cli/create-admin.js` ' +
          'and pass its credentials via E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD.',
      );
    }
  } finally {
    await context.dispose();
  }
}

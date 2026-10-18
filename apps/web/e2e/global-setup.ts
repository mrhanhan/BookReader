import { request } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8180';
const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

/**
 * The suite needs an existing administrator to mint invites. Registration is
 * admin-only by design (and `create-admin` refuses once any user exists), so a
 * missing admin is an environment problem the operator must fix, not
 * something the test may paper over.
 */
export default async function globalSetup(): Promise<void> {
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

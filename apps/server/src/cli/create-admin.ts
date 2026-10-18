import { registerSchema } from '@bookr/shared';
import { z } from 'zod';
import { createAdmin } from '../auth/service';
import { loadConfig } from '../config';
import { closeDb } from '../db/client';
import { createDeps } from '../runtime';

const credentialsSchema = z.object({
  username: registerSchema.shape.username,
  password: registerSchema.shape.password,
});

/** Bootstraps the first administrator from the environment. */
async function main(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    console.error('ADMIN_USERNAME and ADMIN_PASSWORD must both be set');
    process.exitCode = 1;
    return;
  }

  const credentials = credentialsSchema.safeParse({ username, password });
  if (!credentials.success) {
    const message = credentials.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    console.error(`Invalid administrator credentials: ${message.join('; ')}`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const deps = createDeps(config);
  try {
    const { userId } = await createAdmin(deps, {
      username: credentials.data.username,
      password: credentials.data.password,
      displayName: process.env.ADMIN_DISPLAY_NAME ?? credentials.data.username,
    });
    console.log(userId);
  } finally {
    await closeDb(deps.db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

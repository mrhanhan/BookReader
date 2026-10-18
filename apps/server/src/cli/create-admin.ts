import { newId, registerSchema } from '@bookr/shared';
import { z } from 'zod';
import { createAdmin } from '../auth/service';
import { CalibreConverter } from '../books/conversion';
import { loadConfig } from '../config';
import { closeDb, createDb } from '../db/client';
import { FakeJobQueue } from '../jobs/fake';
import { FakeStorage } from '../storage/fake';

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
  const db = createDb(config.databaseUrl);
  try {
    const { userId } = await createAdmin(
      {
        config,
        db,
        storage: new FakeStorage(),
        clock: { now: () => new Date() },
        ids: { newId },
        jobs: new FakeJobQueue(),
        converter: new CalibreConverter(),
      },
      {
        username: credentials.data.username,
        password: credentials.data.password,
        displayName: process.env.ADMIN_DISPLAY_NAME ?? credentials.data.username,
      },
    );
    console.log(userId);
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

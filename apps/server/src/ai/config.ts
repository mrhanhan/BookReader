import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_CHAT_MODEL,
  DEFAULT_AI_REASONER_MODEL,
} from '../config';
import { aiConfig, auditLogs } from '../db/schema';
import { AppError } from '../errors';
import { configKeyFor, decryptSecret, encryptSecret, type EncryptedSecret } from './crypto';

/** Primary key of the singleton configuration row. */
export const AI_CONFIG_ID = 'default';

/** The provider settings used to build one chat client. */
export interface AiRuntimeConfig {
  baseUrl: string;
  chatModel: string;
  reasonerModel: string;
  apiKey: string;
  fakeProvider: boolean;
}

/** Administrator-facing configuration; never contains the API key. */
export interface AiConfigView {
  configured: boolean;
  fakeProvider: boolean;
  baseUrl: string | null;
  chatModel: string | null;
  reasonerModel: string | null;
  hasApiKey: boolean;
  updatedAt: string | null;
}

/** Values an administrator may change in one request. */
export interface WriteAiConfigInput {
  baseUrl?: string;
  chatModel?: string;
  reasonerModel?: string;
  apiKey?: string;
}

/** Plaintext HTTP is only allowed for loopback and container-host endpoints. */
const LOOPBACK_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  'host.docker.internal',
]);

const MODEL_NAME_MAX_LENGTH = 64;
const CONTROL_OR_WHITESPACE = /[\s\u0000-\u001f\u007f]/u;

/**
 * Validates and canonicalizes a provider base URL: HTTPS anywhere, plain HTTP
 * only on loopback or the Docker host, no credentials/query/fragment and no
 * trailing slash.
 */
export function normalizeAiBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Invalid AI base URL');
  }

  const secure = parsed.protocol === 'https:';
  const loopbackHttp = parsed.protocol === 'http:' && LOOPBACK_HTTP_HOSTS.has(parsed.hostname);
  if (!secure && !loopbackHttp) {
    throw new Error('Invalid AI base URL');
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('Invalid AI base URL');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, '')}`;
}

/** Validates a model identifier; it is passed to the provider verbatim. */
export function normalizeModelName(raw: string): string {
  const model = raw.trim();
  if (
    model.length === 0 ||
    model.length > MODEL_NAME_MAX_LENGTH ||
    CONTROL_OR_WHITESPACE.test(model)
  ) {
    throw new Error('Invalid AI model name');
  }
  return model;
}

function validationError(field: string): AppError {
  return new AppError(400, 'VALIDATION_FAILED', { field });
}

function normalizeBaseUrlOrThrow(raw: string): string {
  try {
    return normalizeAiBaseUrl(raw);
  } catch {
    throw validationError('baseUrl');
  }
}

function normalizeModelOrThrow(raw: string, field: 'chatModel' | 'reasonerModel'): string {
  try {
    return normalizeModelName(raw);
  } catch {
    throw validationError(field);
  }
}

/** The built-in provider used by `AI_FAKE_PROVIDER=1`. */
function fakeRuntimeConfig(): AiRuntimeConfig {
  return {
    baseUrl: DEFAULT_AI_BASE_URL,
    chatModel: DEFAULT_AI_CHAT_MODEL,
    reasonerModel: DEFAULT_AI_REASONER_MODEL,
    apiKey: '',
    fakeProvider: true,
  };
}

function fakeConfigView(): AiConfigView {
  return {
    configured: true,
    fakeProvider: true,
    baseUrl: DEFAULT_AI_BASE_URL,
    chatModel: DEFAULT_AI_CHAT_MODEL,
    reasonerModel: DEFAULT_AI_REASONER_MODEL,
    hasApiKey: false,
    updatedAt: null,
  };
}

/**
 * Decrypts the stored key, or returns `null` when the row cannot be read.
 * Callers treat that as "not configured" rather than surfacing key material
 * or ciphertext details.
 */
function decryptRow(
  deps: Pick<AppDeps, 'config'>,
  row: typeof aiConfig.$inferSelect,
): string | null {
  try {
    return decryptSecret(
      {
        ciphertext: row.apiKeyCiphertext,
        iv: row.apiKeyIv,
        tag: row.apiKeyTag,
      },
      configKeyFor(deps.config),
    );
  } catch {
    return null;
  }
}

/** Reads the provider settings used to build a chat client. */
export async function readAiConfig(
  deps: Pick<AppDeps, 'db' | 'config'>,
): Promise<AiRuntimeConfig | null> {
  if (deps.config.ai.fakeProvider) {
    return fakeRuntimeConfig();
  }

  const [row] = await deps.db
    .select()
    .from(aiConfig)
    .where(eq(aiConfig.id, AI_CONFIG_ID))
    .limit(1);
  if (!row) {
    return null;
  }

  const apiKey = decryptRow(deps, row);
  if (apiKey === null) {
    return null;
  }

  return {
    baseUrl: row.baseUrl,
    chatModel: row.chatModel,
    reasonerModel: row.reasonerModel,
    apiKey,
    fakeProvider: false,
  };
}

/** Reads the administrator view; the API key itself is never included. */
export async function readAiConfigView(
  deps: Pick<AppDeps, 'db' | 'config'>,
): Promise<AiConfigView> {
  if (deps.config.ai.fakeProvider) {
    return fakeConfigView();
  }

  const [row] = await deps.db
    .select()
    .from(aiConfig)
    .where(eq(aiConfig.id, AI_CONFIG_ID))
    .limit(1);
  if (!row) {
    return {
      configured: false,
      fakeProvider: false,
      baseUrl: null,
      chatModel: null,
      reasonerModel: null,
      hasApiKey: false,
      updatedAt: null,
    };
  }

  // A row that cannot be decrypted is reported as unconfigured: the
  // administrator must enter the key again after a secret rotation.
  const hasApiKey = decryptRow(deps, row) !== null;
  return {
    configured: hasApiKey,
    fakeProvider: false,
    baseUrl: row.baseUrl,
    chatModel: row.chatModel,
    reasonerModel: row.reasonerModel,
    hasApiKey,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Creates or updates the singleton provider configuration. The first write
 * must include an API key; later writes keep the stored key unless a new one
 * is supplied. Only the ciphertext reaches the database, and the audit entry
 * records field names and values without the key.
 */
export async function writeAiConfig(
  deps: Pick<AppDeps, 'db' | 'config' | 'clock'>,
  actorId: string | null,
  input: WriteAiConfigInput,
): Promise<AiConfigView> {
  // The fake provider ignores stored settings; accepting a write would make the
  // view disagree with what the runtime actually uses.
  if (deps.config.ai.fakeProvider) {
    return fakeConfigView();
  }

  const [existing] = await deps.db
    .select()
    .from(aiConfig)
    .where(eq(aiConfig.id, AI_CONFIG_ID))
    .limit(1);

  if (!existing && input.apiKey === undefined) {
    throw validationError('apiKey');
  }
  if (
    input.apiKey === undefined &&
    existing !== undefined &&
    decryptRow(deps, existing) === null
  ) {
    // The stored key is unreadable (for example after rotating JWT_SECRET);
    // keeping it would leave the provider permanently broken.
    throw validationError('apiKey');
  }

  const baseUrl =
    input.baseUrl !== undefined
      ? normalizeBaseUrlOrThrow(input.baseUrl)
      : (existing?.baseUrl ?? DEFAULT_AI_BASE_URL);
  const chatModel =
    input.chatModel !== undefined
      ? normalizeModelOrThrow(input.chatModel, 'chatModel')
      : (existing?.chatModel ?? DEFAULT_AI_CHAT_MODEL);
  const reasonerModel =
    input.reasonerModel !== undefined
      ? normalizeModelOrThrow(input.reasonerModel, 'reasonerModel')
      : (existing?.reasonerModel ?? DEFAULT_AI_REASONER_MODEL);

  let secret: EncryptedSecret | null = null;
  if (input.apiKey !== undefined) {
    secret = encryptSecret(input.apiKey, configKeyFor(deps.config));
  } else if (existing) {
    secret = {
      ciphertext: existing.apiKeyCiphertext,
      iv: existing.apiKeyIv,
      tag: existing.apiKeyTag,
    };
  } else {
    throw validationError('apiKey');
  }

  const now = deps.clock.now();
  const columns = {
    baseUrl,
    chatModel,
    reasonerModel,
    apiKeyCiphertext: secret.ciphertext,
    apiKeyIv: secret.iv,
    apiKeyTag: secret.tag,
  };

  await deps.db.transaction(async (tx) => {
    await tx
      .insert(aiConfig)
      .values({ id: AI_CONFIG_ID, ...columns, updatedBy: actorId, updatedAt: now })
      .onConflictDoUpdate({
        target: aiConfig.id,
        set: { ...columns, updatedBy: actorId, updatedAt: now },
      });
    await tx.insert(auditLogs).values({
      userId: actorId,
      action: 'ai.config.update',
      target: AI_CONFIG_ID,
      metadata: {
        baseUrl,
        chatModel,
        reasonerModel,
        keyChanged: input.apiKey !== undefined,
      },
    });
  });

  return {
    configured: true,
    fakeProvider: deps.config.ai.fakeProvider,
    baseUrl,
    chatModel,
    reasonerModel,
    hasApiKey: true,
    updatedAt: now.toISOString(),
  };
}

/** Removes the stored provider configuration; the caller writes the audit row. */
export async function deleteAiConfig(deps: Pick<AppDeps, 'db'>): Promise<void> {
  await deps.db.delete(aiConfig).where(eq(aiConfig.id, AI_CONFIG_ID));
}

/**
 * Seeds an empty configuration table from the environment on startup. An
 * existing row always wins, so restarting never resurrects a deleted key.
 */
export async function bootstrapAiConfig(
  deps: Pick<AppDeps, 'db' | 'config' | 'clock'>,
): Promise<'created' | 'skipped'> {
  const bootstrap = deps.config.ai.bootstrap;
  if (bootstrap === null) {
    return 'skipped';
  }

  const [existing] = await deps.db
    .select({ id: aiConfig.id })
    .from(aiConfig)
    .where(eq(aiConfig.id, AI_CONFIG_ID))
    .limit(1);
  if (existing) {
    return 'skipped';
  }

  const baseUrl = normalizeAiBaseUrl(bootstrap.baseUrl);
  const chatModel = normalizeModelName(bootstrap.chatModel);
  const reasonerModel = normalizeModelName(bootstrap.reasonerModel);
  const secret = encryptSecret(bootstrap.apiKey, configKeyFor(deps.config));
  const now = deps.clock.now();

  const created = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .insert(aiConfig)
      .values({
        id: AI_CONFIG_ID,
        baseUrl,
        chatModel,
        reasonerModel,
        apiKeyCiphertext: secret.ciphertext,
        apiKeyIv: secret.iv,
        apiKeyTag: secret.tag,
        updatedBy: null,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: aiConfig.id })
      .returning({ id: aiConfig.id });
    if (rows.length === 0) {
      return false;
    }

    await tx.insert(auditLogs).values({
      userId: null,
      action: 'ai.config.bootstrap',
      target: AI_CONFIG_ID,
      metadata: { baseUrl, chatModel, reasonerModel },
    });
    return true;
  });

  return created ? 'created' : 'skipped';
}

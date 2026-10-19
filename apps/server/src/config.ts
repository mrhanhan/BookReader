import {
  BACKUP_STALE_HOURS,
  LIBRARY_QUOTA_BYTES,
  MEMBER_UPLOAD_QUOTA_BYTES,
} from '@bookr/shared';
import { z } from 'zod';

/** Default provider endpoint used until an administrator changes it. */
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com/v1';
/** Default model used for ordinary chat and reader actions. */
export const DEFAULT_AI_CHAT_MODEL = 'deepseek-chat';
/** Default model used for reasoning-heavy actions. */
export const DEFAULT_AI_REASONER_MODEL = 'deepseek-reasoner';
/** Free disk space below this level triggers an alert (10 GiB). */
export const DEFAULT_DISK_ALERT_FREE_BYTES = 10_737_418_240;
/** How often the background monitor evaluates backup conditions. */
export const DEFAULT_MONITOR_INTERVAL_MS = 300_000;

export interface AppConfig {
  port: number;
  host: string;
  /**
   * Number of trusted reverse-proxy hops, or `false` when disabled. Docker
   * Compose deployed behind Caddy must set `TRUST_PROXY=true` (equivalent to
   * one hop), otherwise every request carries Caddy's address and login rate
   * limiting keys on it instead of the real client IP.
   */
  trustProxy: number | false;
  databaseUrl: string;
  s3: {
    endpoint: string;
    /**
     * Endpoint baked into presigned URLs. Browsers follow these directly, so
     * behind Docker they cannot use the container-internal `endpoint`.
     */
    publicEndpoint: string;
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  jwtSecret: string;
  libraryQuotaBytes: number;
  memberUploadQuotaBytes: number;
  loginRateLimit: number;
  /** Browser and native-app origins allowed to call the API. */
  corsOrigins: string[];
  ai: {
    /** Returns deterministic local output instead of calling a provider. */
    fakeProvider: boolean;
    /** Key material for encrypting the provider API key at rest. */
    configSecret?: string;
    contextTokenBudget: number;
    requestTimeoutMs: number;
    /**
     * Provider settings used once to seed an empty configuration table.
     * `null` when `AI_API_KEY` is unset.
     */
    bootstrap: {
      apiKey: string;
      baseUrl: string;
      chatModel: string;
      reasonerModel: string;
    } | null;
  };
  backup: {
    /**
     * Shared secret accepted from backup hosts as `X-Backup-Token`. `null`
     * disables the token channel; admin JWTs still work.
     */
    token: string | null;
  };
  alerts: {
    /** Receives one POST per newly observed incident; `null` disables delivery. */
    webhookUrl: string | null;
    /** Free space below this many bytes raises the disk alert. */
    diskFreeThresholdBytes: number;
    /** A source with no evidence of activity for this long is stale/silent. */
    staleHours: number;
    /** Period of the background monitor loop. */
    monitorIntervalMs: number;
  };
}

/**
 * Origins accepted by default: the Docker Compose web app plus the Tauri and
 * Capacitor webviews. Deployments override this with a comma-separated
 * `CORS_ORIGIN` list.
 */
export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:8180',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'https://localhost',
  'capacitor://localhost',
];

/** Parses `TRUST_PROXY` into a number of trusted proxy hops, or `false`. */
const trustProxySchema = z
  .string()
  .optional()
  .transform((value, ctx): number | false => {
    if (value === undefined || value === '' || value === 'false' || value === '0') {
      return false;
    }
    if (value === 'true') {
      // Fastify treats `true` as trusting every hop, which lets clients spoof
      // their IP. One proxy hop matches the Caddy deployment.
      return 1;
    }
    const hops = Number(value);
    if (Number.isInteger(hops) && hops > 0) {
      return hops;
    }
    ctx.addIssue({
      code: 'custom',
      message: 'must be "true", "false" or a positive integer number of trusted proxies',
      input: value,
    });
    return z.NEVER;
  });

/** An optional environment string; an empty value counts as unset. */
const optionalEnvString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(1).optional(),
);

/** An optional secret that must be at least 32 characters when present. */
const optionalEnvSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);

/**
 * An optional webhook endpoint. Alert bodies carry only status and counts, so
 * any http(s) receiver is acceptable; other schemes are rejected at startup.
 */
const optionalWebhookUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .url()
    .refine((value) => {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:';
    }, { message: 'must use the http or https scheme' })
    .optional(),
);

/** Accepts `1`/`true` and `0`/`false`; anything else is a configuration error. */
const envBoolean = z
  .string()
  .optional()
  .transform((value, ctx): boolean => {
    if (value === undefined || value === '' || value === '0' || value === 'false') {
      return false;
    }
    if (value === '1' || value === 'true') {
      return true;
    }
    ctx.addIssue({
      code: 'custom',
      message: 'must be one of 1, true, 0, false',
      input: value,
    });
    return z.NEVER;
  });

const corsOriginsSchema = z
  .string()
  .default(DEFAULT_CORS_ORIGINS.join(','))
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )
  .refine((origins) => origins.length > 0, {
    message: 'must list at least one origin',
  });

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUST_PROXY: trustProxySchema,
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_PUBLIC_ENDPOINT: z.string().min(1).optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('bookr'),
  JWT_SECRET: z.string().min(32),
  LIBRARY_QUOTA_BYTES: z.coerce.number().int().positive().default(LIBRARY_QUOTA_BYTES),
  MEMBER_UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().default(MEMBER_UPLOAD_QUOTA_BYTES),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  CORS_ORIGIN: corsOriginsSchema,
  AI_CONFIG_SECRET: optionalEnvSecret,
  AI_FAKE_PROVIDER: envBoolean,
  AI_API_KEY: optionalEnvString,
  AI_BASE_URL: optionalEnvString,
  AI_CHAT_MODEL: optionalEnvString,
  AI_REASONER_MODEL: optionalEnvString,
  AI_CONTEXT_TOKEN_BUDGET: z.coerce.number().int().min(1000).max(32000).default(8000),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(60000),
  BACKUP_TOKEN: optionalEnvSecret,
  ALERT_WEBHOOK_URL: optionalWebhookUrl,
  DISK_ALERT_FREE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_DISK_ALERT_FREE_BYTES),
  BACKUP_STALE_HOURS: z.coerce.number().int().min(1).max(168).default(BACKUP_STALE_HOURS),
  MONITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3_600_000)
    .default(DEFAULT_MONITOR_INTERVAL_MS),
});

function describeIssue(issue: z.ZodIssue, env: NodeJS.ProcessEnv): string {
  const key = String(issue.path[0] ?? 'configuration');

  if (env[key] === undefined || env[key] === '') {
    if (issue.code === 'too_small' || issue.code === 'invalid_type') {
      return `${key} is required`;
    }
  }
  if (issue.code === 'too_small' && issue.origin === 'string') {
    return `${key} must be at least ${String(issue.minimum)} characters`;
  }
  if (issue.code === 'invalid_type') {
    return `${key} has an invalid value`;
  }
  if (issue.code === 'too_small') {
    return `${key} must be at least ${String(issue.minimum)}`;
  }
  if (issue.code === 'too_big') {
    return `${key} must be at most ${String(issue.maximum)}`;
  }
  return `${key}: ${issue.message}`;
}

/** Parses and validates process environment into a typed application config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const messages = [...new Set(result.error.issues.map((issue) => describeIssue(issue, env)))];
    throw new Error(`Invalid environment configuration: ${messages.join('; ')}`);
  }

  const parsed = result.data;
  return {
    port: parsed.PORT,
    host: parsed.HOST,
    trustProxy: parsed.TRUST_PROXY,
    databaseUrl: parsed.DATABASE_URL,
    s3: {
      endpoint: parsed.S3_ENDPOINT,
      publicEndpoint: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
      region: parsed.S3_REGION,
      accessKey: parsed.S3_ACCESS_KEY,
      secretKey: parsed.S3_SECRET_KEY,
      bucket: parsed.S3_BUCKET,
    },
    jwtSecret: parsed.JWT_SECRET,
    libraryQuotaBytes: parsed.LIBRARY_QUOTA_BYTES,
    memberUploadQuotaBytes: parsed.MEMBER_UPLOAD_QUOTA_BYTES,
    loginRateLimit: parsed.LOGIN_RATE_LIMIT,
    corsOrigins: parsed.CORS_ORIGIN,
    ai: {
      fakeProvider: parsed.AI_FAKE_PROVIDER,
      ...(parsed.AI_CONFIG_SECRET !== undefined
        ? { configSecret: parsed.AI_CONFIG_SECRET }
        : {}),
      contextTokenBudget: parsed.AI_CONTEXT_TOKEN_BUDGET,
      requestTimeoutMs: parsed.AI_REQUEST_TIMEOUT_MS,
      bootstrap:
        parsed.AI_API_KEY !== undefined
          ? {
              apiKey: parsed.AI_API_KEY,
              baseUrl: parsed.AI_BASE_URL ?? DEFAULT_AI_BASE_URL,
              chatModel: parsed.AI_CHAT_MODEL ?? DEFAULT_AI_CHAT_MODEL,
              reasonerModel: parsed.AI_REASONER_MODEL ?? DEFAULT_AI_REASONER_MODEL,
            }
          : null,
    },
    backup: {
      token: parsed.BACKUP_TOKEN ?? null,
    },
    alerts: {
      webhookUrl: parsed.ALERT_WEBHOOK_URL ?? null,
      diskFreeThresholdBytes: parsed.DISK_ALERT_FREE_BYTES,
      staleHours: parsed.BACKUP_STALE_HOURS,
      monitorIntervalMs: parsed.MONITOR_INTERVAL_MS,
    },
  };
}

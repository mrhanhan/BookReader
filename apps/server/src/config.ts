import {
  LIBRARY_QUOTA_BYTES,
  MEMBER_UPLOAD_QUOTA_BYTES,
} from '@bookr/shared';
import { z } from 'zod';

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
    region: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
  };
  jwtSecret: string;
  libraryQuotaBytes: number;
  memberUploadQuotaBytes: number;
  loginRateLimit: number;
  corsOrigin: string;
}

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

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUST_PROXY: trustProxySchema,
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1).default('bookr'),
  JWT_SECRET: z.string().min(32),
  LIBRARY_QUOTA_BYTES: z.coerce.number().int().positive().default(LIBRARY_QUOTA_BYTES),
  MEMBER_UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().default(MEMBER_UPLOAD_QUOTA_BYTES),
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),
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
      region: parsed.S3_REGION,
      accessKey: parsed.S3_ACCESS_KEY,
      secretKey: parsed.S3_SECRET_KEY,
      bucket: parsed.S3_BUCKET,
    },
    jwtSecret: parsed.JWT_SECRET,
    libraryQuotaBytes: parsed.LIBRARY_QUOTA_BYTES,
    memberUploadQuotaBytes: parsed.MEMBER_UPLOAD_QUOTA_BYTES,
    loginRateLimit: parsed.LOGIN_RATE_LIMIT,
    corsOrigin: parsed.CORS_ORIGIN,
  };
}

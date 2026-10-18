import type { ApiErrorBody, ErrorCode } from '@bookr/shared';
import { ERROR_CODES } from '@bookr/shared';

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  [ERROR_CODES.UNAUTHORIZED]: 'Authentication required',
  [ERROR_CODES.FORBIDDEN]: 'You do not have permission to perform this action',
  [ERROR_CODES.NOT_FOUND]: 'Resource not found',
  [ERROR_CODES.CONFLICT]: 'Resource already exists',
  [ERROR_CODES.DUPLICATE_BOOK]: 'This file already exists in the library',
  [ERROR_CODES.QUOTA_EXCEEDED]: 'Storage quota exceeded',
  [ERROR_CODES.INVALID_FILE]: 'The uploaded file is not valid',
  [ERROR_CODES.BOOK_NOT_READY]: 'This book is not ready to read',
  [ERROR_CODES.REFLOW_NOT_READY]: 'This book has no reflow pack yet',
  [ERROR_CODES.REFLOW_INVALID]: 'The reflow pack is not valid for this book',
  [ERROR_CODES.FILE_MISSING]: 'The book file is missing',
  [ERROR_CODES.VALIDATION_FAILED]: 'Request validation failed',
  [ERROR_CODES.INVITE_INVALID]: 'Invite code is invalid or expired',
  [ERROR_CODES.RATE_LIMITED]: 'Too many requests',
  [ERROR_CODES.INTERNAL]: 'Internal server error',
  [ERROR_CODES.AI_DISABLED]: 'AI companion is disabled',
  [ERROR_CODES.AI_NOT_CONFIGURED]: 'AI is not configured',
  [ERROR_CODES.AI_QUOTA_EXCEEDED]: 'AI quota exceeded',
  [ERROR_CODES.AI_UPSTREAM_FAILED]: 'AI service is temporarily unavailable',
  [ERROR_CODES.AI_TIMEOUT]: 'AI request timed out',
};

/** Default user-facing message for an error code. */
export function defaultMessageFor(code: ErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/** An expected API failure that maps directly onto the error envelope. */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: ErrorCode, details?: Record<string, unknown>, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

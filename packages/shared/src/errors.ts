/** Machine-readable error codes returned in the API error envelope. */
export const ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  DUPLICATE_BOOK: 'DUPLICATE_BOOK',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  INVALID_FILE: 'INVALID_FILE',
  BOOK_NOT_READY: 'BOOK_NOT_READY',
  FILE_MISSING: 'FILE_MISSING',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVITE_INVALID: 'INVITE_INVALID',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Shape of every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

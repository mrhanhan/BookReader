import type { ErrorCode } from '@bookr/shared';
import { ApiError } from '../api/client';

export type ErrorContext = 'default' | 'login';

/**
 * Server error text is not localized, so the web client owns the user-facing
 * copy. Unknown codes and network failures fall back to a safe Chinese line.
 */
const MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '找不到请求的内容',
  CONFLICT: '该内容已存在',
  DUPLICATE_BOOK: '这本书已经在书架上了',
  QUOTA_EXCEEDED: '存储空间不足，请联系管理员',
  INVALID_FILE: '文件无效或格式不受支持',
  BOOK_NOT_READY: '这本书正在转换，请稍后再试',
  FILE_MISSING: '这本书的文件不存在',
  VALIDATION_FAILED: '提交的信息有误，请检查后重试',
  INVITE_INVALID: '邀请码无效或已过期',
  RATE_LIMITED: '尝试次数过多，请稍后再试',
  INTERNAL: '服务器出了点问题，请稍后重试',
};

const LOGIN_OVERRIDES: Partial<Record<ErrorCode, string>> = {
  UNAUTHORIZED: '用户名或密码错误',
};

const FALLBACK = '操作失败，请稍后重试';

export function messageForApiError(error: unknown, context: ErrorContext = 'default'): string {
  if (!(error instanceof ApiError)) return FALLBACK;

  const override = context === 'login' ? LOGIN_OVERRIDES[error.code] : undefined;
  return override ?? MESSAGES[error.code] ?? FALLBACK;
}

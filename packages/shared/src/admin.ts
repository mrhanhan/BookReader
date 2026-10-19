import { z } from 'zod';
import { isValidTimeZone } from './stats';

/** IANA zone applied to new accounts that do not pick one explicitly. */
export const DEFAULT_USER_TIMEZONE = 'Asia/Shanghai';
/** A backup source is considered silent/overdue after this many hours. */
export const BACKUP_STALE_HOURS = 24;
/** Number of latest backup reports returned by the status endpoint. */
export const BACKUP_REPORTS_LIMIT = 20;
/** Number of latest alert deliveries returned by the status endpoint. */
export const ALERT_EVENTS_LIMIT = 10;

/** Longest accepted IANA identifier; guards against oversized payloads. */
const MAX_TIMEZONE_LENGTH = 64;
/** Longest free-form message kept from a backup heartbeat. */
const MAX_BACKUP_MESSAGE_LENGTH = 1_000;

export interface SystemSettingsDto {
  registrationEnabled: boolean;
  defaultTimezone: string;
  updatedAt: string | null;
}

export interface UpdateSystemSettingsInput {
  registrationEnabled?: boolean;
  defaultTimezone?: string;
}

export const updateSystemSettingsSchema: z.ZodType<UpdateSystemSettingsInput> = z
  .object({
    registrationEnabled: z.boolean().optional(),
    defaultTimezone: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TIMEZONE_LENGTH)
      .refine(isValidTimeZone, { message: 'defaultTimezone must be a valid IANA time zone' })
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.registrationEnabled === undefined && input.defaultTimezone === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'at least one setting must be provided',
      });
    }
  });

export interface AuditLogEntryDto {
  id: string;
  userId: string | null;
  displayName: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditLogPageDto {
  items: AuditLogEntryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AdminStorageOverviewDto {
  totalBytes: number;
  usedBytes: number;
  perMember: Array<{ userId: string; displayName: string; usedBytes: number }>;
  topBooks: Array<{ id: string; title: string; sizeBytes: number }>;
}

export const BACKUP_SOURCES = ['server-export', 'backup-pc'] as const;
export type BackupSource = (typeof BACKUP_SOURCES)[number];
export const BACKUP_REPORT_STATUSES = ['success', 'failure'] as const;
export type BackupReportStatus = (typeof BACKUP_REPORT_STATUSES)[number];

export interface BackupHeartbeatInput {
  source: BackupSource;
  status: BackupReportStatus;
  /** ISO 8601; must carry a zone offset. */
  startedAt: string;
  /** ISO 8601; must carry a zone offset. */
  finishedAt: string;
  bytes?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  message?: string;
}

export const backupHeartbeatSchema: z.ZodType<BackupHeartbeatInput> = z
  .object({
    source: z.enum(BACKUP_SOURCES),
    status: z.enum(BACKUP_REPORT_STATUSES),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    bytes: z.number().int().nonnegative().safe().optional(),
    diskFreeBytes: z.number().int().nonnegative().safe().optional(),
    diskTotalBytes: z.number().int().nonnegative().safe().optional(),
    message: z.string().trim().max(MAX_BACKUP_MESSAGE_LENGTH).optional(),
  })
  .superRefine((heartbeat, ctx) => {
    if (Date.parse(heartbeat.finishedAt) < Date.parse(heartbeat.startedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['finishedAt'],
        message: 'finishedAt must not precede startedAt',
      });
    }

    if (
      heartbeat.diskFreeBytes !== undefined &&
      heartbeat.diskTotalBytes !== undefined &&
      heartbeat.diskFreeBytes > heartbeat.diskTotalBytes
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['diskFreeBytes'],
        message: 'diskFreeBytes must not exceed diskTotalBytes',
      });
    }
  });

export interface BackupReportDto {
  id: string;
  source: BackupSource;
  status: BackupReportStatus;
  startedAt: string;
  finishedAt: string;
  bytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  message: string | null;
  receivedAt: string;
}

export interface AlertEventDto {
  id: string;
  key: string;
  severity: 'warning' | 'critical';
  message: string;
  sentAt: string;
  status: 'sent' | 'failed';
  error: string | null;
}

export interface BackupStatusDto {
  lastSuccessAt: string | null;
  lastServerExportAt: string | null;
  lastBackupPcAt: string | null;
  backupStale: boolean;
  backupPcSilent: boolean;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskLow: boolean;
  reports: BackupReportDto[];
  alerts: AlertEventDto[];
}

import { z } from 'zod';
import { rectSchema } from '../locators';
import type { BookDto } from './books';
import type { PresignedUploadTarget } from './uploads';

/** Version stamped into every reflow pack; readers reject anything else. */
export const REFLOW_PACK_SCHEMA_VERSION = 1;

/** Upper bound for an uploaded pack; completion also compares the stored size. */
export const MAX_REFLOW_PACK_BYTES = 32 * 1024 * 1024;

export const MAX_REFLOW_PAGES = 5000;
export const MAX_REFLOW_BLOCKS = 200000;
export const MAX_REFLOW_BLOCKS_PER_PAGE = 2000;

/** Longest text a single block may carry, in UTF-16 code units. */
export const MAX_REFLOW_TEXT_LENGTH = 20000;

/** Kinds of content the preprocessing tool can emit for one block. */
export const REFLOW_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'image',
  'table',
  'formula',
  'fallback',
] as const;

export type ReflowBlockType = (typeof REFLOW_BLOCK_TYPES)[number];

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const reflowBlockSchema = z
  .object({
    /** Stable within its page; locators refer to blocks by this id. */
    id: z.string().min(1).max(64),
    type: z.enum(REFLOW_BLOCK_TYPES),
    text: z.string().max(MAX_REFLOW_TEXT_LENGTH).optional(),
    level: z.number().int().min(1).max(6).optional(),
    /** Normalized page coordinates, matching PDF highlight rects. */
    rect: rectSchema,
    /** Offsets into the source page text, in UTF-16 code units. */
    sourceCharStart: z.number().int().min(0).optional(),
    sourceCharEnd: z.number().int().min(0).optional(),
  })
  .superRefine((block, ctx) => {
    // Anything a reader must render as prose has to carry its text.
    if ((block.type === 'heading' || block.type === 'paragraph') && block.text === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: `${block.type} blocks require text`,
      });
    }
    if (block.type === 'heading' && block.level === undefined) {
      ctx.addIssue({ code: 'custom', path: ['level'], message: 'heading blocks require a level' });
    }
    if (
      block.sourceCharStart !== undefined &&
      block.sourceCharEnd !== undefined &&
      block.sourceCharEnd < block.sourceCharStart
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceCharEnd'],
        message: 'sourceCharEnd must not precede sourceCharStart',
      });
    }
  });

export type ReflowBlock = z.infer<typeof reflowBlockSchema>;

export const reflowPageSchema = z
  .object({
    page: z.number().int().min(1),
    /** Page size in source points, used to scale image and formula blocks. */
    width: z.number().positive(),
    height: z.number().positive(),
    blocks: z.array(reflowBlockSchema).max(MAX_REFLOW_BLOCKS_PER_PAGE),
  })
  .superRefine((page, ctx) => {
    // Locators address blocks as (sourcePage, blockId), so ids must be unique
    // within a page even though they may repeat on another page.
    const seen = new Set<string>();
    for (const [index, block] of page.blocks.entries()) {
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'id'],
          message: 'block id must be unique within a page',
        });
      }
      seen.add(block.id);
    }
  });

export type ReflowPage = z.infer<typeof reflowPageSchema>;

const reflowSourceSchema = z.object({
  /** SHA-256 of the original book file; uploads must match the stored book. */
  sha256: z.string().regex(SHA256_PATTERN),
  pageCount: z.number().int().min(1).max(MAX_REFLOW_PAGES),
});

const reflowToolSchema = z.object({
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
});

const reflowQualitySchema = z.object({
  pages: z.number().int().min(0).max(MAX_REFLOW_PAGES),
  textBlocks: z.number().int().min(0).max(MAX_REFLOW_BLOCKS),
  /** Source pages rendered as a single fallback image block. */
  fallbackPages: z.array(z.number().int().min(1)).max(MAX_REFLOW_PAGES),
  ocrPages: z.array(z.number().int().min(1)).max(MAX_REFLOW_PAGES),
  avgConfidence: z.number().min(0).max(1).nullable(),
  warnings: z.array(z.string().max(2000)).max(500),
});

const reflowTocEntrySchema = z.object({
  label: z.string().min(1).max(500),
  page: z.number().int().min(1),
  level: z.number().int().min(1).max(6),
});

/**
 * The `*.bookr.json` pack produced by the local preprocessing tool.
 *
 * Pages are stored in reading order and numbered 1..n so the reader can index
 * them by position. Block ids are unique per page and source offsets are
 * UTF-16 code units, matching JavaScript string indexing.
 */
export const reflowPackSchema = z
  .object({
    schemaVersion: z.literal(REFLOW_PACK_SCHEMA_VERSION),
    source: reflowSourceSchema,
    generatedAt: z.iso.datetime(),
    tool: reflowToolSchema,
    quality: reflowQualitySchema,
    toc: z.array(reflowTocEntrySchema).max(MAX_REFLOW_PAGES),
    pages: z.array(reflowPageSchema).min(1).max(MAX_REFLOW_PAGES),
  })
  .superRefine((pack, ctx) => {
    if (pack.pages.length !== pack.source.pageCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['pages'],
        message: 'pages.length must equal source.pageCount',
      });
    }

    let blockCount = 0;
    for (const [index, page] of pack.pages.entries()) {
      if (page.page !== index + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['pages', index, 'page'],
          message: 'pages must be numbered 1..n in order',
        });
      }
      blockCount += page.blocks.length;
    }

    if (blockCount > MAX_REFLOW_BLOCKS) {
      ctx.addIssue({
        code: 'custom',
        path: ['pages'],
        message: `packs may contain at most ${MAX_REFLOW_BLOCKS} blocks`,
      });
    }
  });

export type ReflowPack = z.infer<typeof reflowPackSchema>;

/** Body of `POST /api/books/:id/reflow/uploads`. */
export const reflowUploadCreateSchema = z.object({
  size: z.number().int().min(1).max(MAX_REFLOW_PACK_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
});

export type ReflowUploadCreate = z.infer<typeof reflowUploadCreateSchema>;

/** What the reader needs to know about a stored pack without downloading it. */
export interface ReflowPackSummary {
  schemaVersion: number;
  pageCount: number;
  blockCount: number;
  fallbackPages: number[];
}

/** Presigned download information for one book's pack. */
export interface ReflowFileInfo {
  url: string;
  schemaVersion: number;
  pageCount: number;
  expiresIn: number;
}

/** Response of `POST /api/books/:id/reflow/uploads`. */
export interface CreateReflowUploadResponse {
  uploadId: string;
  upload: PresignedUploadTarget;
  expiresAt: string;
}

/** Response of `POST /api/books/:id/reflow/uploads/:uploadId/complete`. */
export interface CompleteReflowUploadResponse {
  book: BookDto;
  pack: ReflowPackSummary;
}

/** Total number of blocks across every page of a validated pack. */
export function reflowPackBlockCount(pack: ReflowPack): number {
  return pack.pages.reduce((total, page) => total + page.blocks.length, 0);
}

/** Compact pack metadata returned after an upload completes. */
export function reflowPackSummary(pack: ReflowPack): ReflowPackSummary {
  return {
    schemaVersion: pack.schemaVersion,
    pageCount: pack.pages.length,
    blockCount: reflowPackBlockCount(pack),
    fallbackPages: [...pack.quality.fallbackPages],
  };
}

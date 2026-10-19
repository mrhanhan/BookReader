import { NOTE_EXPORT_MAX_ITEMS } from '@bookr/shared';
import { describeLocator } from '../reading/locator-label';
import type { NoteQueryRow } from './repo';

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

/** Formats a date as `YYYY-MM-DD` in the user's timezone. */
function formatLocalDate(date: Date, timezone: string): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { ...DATE_OPTIONS, timeZone: timezone });
  } catch {
    // A stored zone the runtime no longer knows must not break an export.
    formatter = new Intl.DateTimeFormat('en-CA', { ...DATE_OPTIONS, timeZone: 'UTC' });
  }
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Book heading of one note block: `## 《title》` with an optional author. */
function bookHeading(row: NoteQueryRow): string {
  // A newline in imported metadata must not split the heading into two lines.
  const title = row.book.title.replace(/\s+/g, ' ').trim();
  const author = row.book.author?.replace(/\s+/g, ' ').trim();
  return author ? `## 《${title}》 · ${author}` : `## 《${title}》`;
}

/**
 * Keeps a note from opening a new Markdown block (heading, quote, list or
 * thematic break) when it is rendered as plain export text.
 */
function escapeMarkdownLine(line: string): string {
  return line.replace(
    /^(\s*)(`{3,}|#{1,6}(?=\s)|>|[-*+](?=\s)|\d+\.(?=\s)|---+\s*$)/,
    (_match, indent: string, marker: string) => `${indent}\\${marker}`,
  );
}

/**
 * Renders one note as the lines below its book heading: position, quote, note,
 * tags and date. The caller decides where the book heading goes.
 */
function noteBlockLines(row: NoteQueryRow, timezone: string): string[] {
  const lines = [`### ${describeLocator(row.annotation.locator)}`, ''];

  // Prefix every source line so Markdown headings inside a highlight cannot
  // escape the quote; genuinely empty lines stay as a bare `>`.
  const quoteLines = row.annotation.selectedText.split(/\r\n|\r|\n/);
  lines.push(...quoteLines.map((line) => (line === '' ? '>' : `> ${line}`)));

  const noteText = row.annotation.noteText;
  if (noteText !== null && noteText.trim() !== '') {
    lines.push('', ...noteText.split(/\r\n|\r|\n/).map(escapeMarkdownLine));
  }

  const tags = row.annotation.tags ?? [];
  if (tags.length > 0) {
    // Tags may come from older rows with embedded newlines; keep the label on one line.
    lines.push(
      '',
      `标签：${tags
        .map((tag) => tag.replace(/\s+/g, ' ').trim())
        .filter((tag) => tag !== '')
        .map((tag) => `#${tag}`)
        .join(' ')}`,
    );
  }

  lines.push('', `*${formatLocalDate(row.annotation.createdAt, timezone)}*`);
  return lines;
}

/**
 * Renders the whole export. Notes are grouped by book so each `##` heading
 * appears once; consecutive notes are separated by a blank line, `---` and a
 * blank line, and the file ends with a single newline.
 */
export function buildNotesMarkdown(input: {
  notes: NoteQueryRow[];
  total: number;
  truncated: boolean;
  generatedAt: Date;
  timezone: string;
}): string {
  const header = [
    '# 笔记库',
    '',
    `导出时间：${formatLocalDate(input.generatedAt, input.timezone)}`,
    `共 ${input.total} 条笔记`,
  ];
  if (input.truncated) {
    header.push(`仅导出前 ${NOTE_EXPORT_MAX_ITEMS} 条（按书名与阅读时间排序）。`);
  }

  // Notes arrive sorted by book title then creation time. A Map keeps that
  // order inside every book group and emits one heading per book.
  const groups = new Map<string, NoteQueryRow[]>();
  for (const row of input.notes) {
    const group = groups.get(row.book.id);
    if (group) {
      group.push(row);
    } else {
      groups.set(row.book.id, [row]);
    }
  }

  const sections: string[] = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    if (!first) {
      continue;
    }
    const lines = [bookHeading(first), ''];
    rows.forEach((row, index) => {
      if (index > 0) {
        lines.push('', '---', '');
      }
      lines.push(...noteBlockLines(row, input.timezone));
    });
    sections.push(lines.join('\n'));
  }

  const head = header.join('\n');
  if (sections.length === 0) {
    return `${head}\n`;
  }
  return `${head}\n\n${sections.join('\n\n---\n\n')}\n`;
}

/** Strips filesystem-hostile and control characters from a book title. */
function sanitizeBookTitle(title: string | null): string {
  if (title === null) {
    return '';
  }
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\p{Cc}/gu, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 50).join('').trim();
}

/** Download name of an export: `笔记-<title>-YYYYMMDD.md` or `笔记库-YYYYMMDD.md`. */
export function notesExportFilename(input: {
  bookTitle: string | null;
  generatedAt: Date;
  timezone: string;
}): string {
  const stamp = formatLocalDate(input.generatedAt, input.timezone).replaceAll('-', '');
  const title = sanitizeBookTitle(input.bookTitle);
  return title ? `笔记-${title}-${stamp}.md` : `笔记库-${stamp}.md`;
}

/**
 * ASCII fallback of the Content-Disposition filename, derived from the same
 * date stamp as `filename` so both variants always agree.
 */
export function notesExportAsciiFilename(filename: string): string {
  const match = /-(\d{4})(\d{2})(\d{2})\.md$/.exec(filename);
  if (!match) {
    return 'notes.md';
  }
  return `notes-${match[1]}-${match[2]}-${match[3]}.md`;
}

/** Reads the extended filename parameter for a Content-Disposition header. */
export function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Supported book file formats, matching the upload validation rules. */
export const BOOK_FORMATS = ['pdf', 'epub', 'mobi', 'azw3'] as const;

/** Reading progress states for a book. */
export const BOOK_STATUSES = ['unread', 'reading', 'finished'] as const;

/** Maximum size of a single uploaded file: 500 MiB. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** Default total storage for the shared library: 80 GiB. */
export const LIBRARY_QUOTA_BYTES = 80 * 1024 ** 3;

/** Default upload quota per member: 20 GiB. */
export const MEMBER_UPLOAD_QUOTA_BYTES = 20 * 1024 ** 3;

/** Number of days a deleted book stays in the trash before permanent removal. */
export const TRASH_RETENTION_DAYS = 30;

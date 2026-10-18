"""Detection helpers used by the build pipeline."""

from __future__ import annotations

from .model import ExtractedPage, utf16_len


def _page_text_chars(page: ExtractedPage) -> int:
    """Characters on a page; ``None`` falls back to the extracted lines."""
    if page.text_chars is None:
        return sum(utf16_len(line.text) for line in page.lines)
    return page.text_chars


def has_usable_text_layer(
    pages: list[ExtractedPage],
    min_chars_per_page: int = 100,
) -> bool:
    """Return True when at least half of the pages carry a real text layer.

    A handful of text pages (cover, copyright, index) does not make a scanned
    book convertible without OCR, so a single text page is not enough.
    """
    if not pages:
        return False
    text_pages = sum(1 for page in pages if _page_text_chars(page) >= min_chars_per_page)
    return text_pages * 2 >= len(pages)

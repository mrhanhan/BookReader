"""Heuristic layout analysis: turn raw PDF lines into reflow blocks.

The heuristics are deliberately simple: the pack keeps text and source
geometry only, and visually complex content (tables, formulas, images) is
re-rendered from the source PDF by the reader.
"""

from __future__ import annotations

import re
import statistics

from .model import Block, ExtractedPage, RawLine, normalize_rect, utf16_len

PAGE_NUMBER_RE = re.compile(r"^[-–—]?\s*\d+\s*[-–—]?$")
MARGIN_RATIO = 0.06
DEFAULT_BODY_SIZE = 11.0

_WHITESPACE_RE = re.compile(r"\s+")
_TABLE_GAP_RE = re.compile(r"\s{2,}")
_CJK_RE = re.compile(
    "[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]"
)
_TERMINAL_PUNCTUATION = "。！？.!?…"
_TRAILING_CLOSERS = "」』”’\"')）》】"
_FORMULA_SYMBOLS = "=∫∑√±×÷≠≤≥^_"
_FORMULA_BAN = "。！？"


def _non_empty(lines: list[RawLine]) -> list[RawLine]:
    return [line for line in lines if line.text.strip()]


def body_font_size(lines: list[RawLine]) -> float:
    """Character-weighted median font size; empty lines are ignored."""
    weighted: list[float] = []
    for line in _non_empty(lines):
        weighted.extend([line.font_size] * utf16_len(line.text))
    if not weighted:
        return DEFAULT_BODY_SIZE
    return float(statistics.median(weighted))


def median_line_height(lines: list[RawLine]) -> float:
    """Median box height of the non-empty lines."""
    heights = [line.y1 - line.y0 for line in _non_empty(lines)]
    if not heights:
        return 0.0
    return float(statistics.median(heights))


def merge_lines(texts: list[str]) -> str:
    """Join physical lines into one block of prose.

    CJK wraps join without a space, an ASCII hyphen at a line end is dropped
    before a lowercase continuation, and every other break becomes a space.
    """
    parts = [text.strip() for text in texts if text and text.strip()]
    if not parts:
        return ""

    merged = parts[0]
    for part in parts[1:]:
        last = merged[-1]
        first = part[0]
        if last == "-" and first.islower():
            merged = merged[:-1] + part
        elif _CJK_RE.match(last) and _CJK_RE.match(first):
            merged += part
        else:
            merged += " " + part
    return merged


def _normalize_margin_text(text: str) -> str:
    """Digits become ``#`` and whitespace collapses, for noise matching."""
    return _WHITESPACE_RE.sub(" ", re.sub(r"\d", "#", text.strip()))


def _in_margin(line: RawLine, height: float) -> bool:
    return line.y0 < MARGIN_RATIO * height or line.y1 > (1.0 - MARGIN_RATIO) * height


def repeated_margin_texts(
    pages: list[ExtractedPage],
    threshold: float = 0.3,
) -> set[str]:
    """Normalized margin texts that appear on at least ``threshold`` of pages.

    Running headers, footers and page numbers repeat across pages; anything
    that does is treated as noise by :func:`lines_to_blocks`.
    """
    if not pages:
        return set()

    counts: dict[str, int] = {}
    for page in pages:
        normalized = {
            _normalize_margin_text(line.text)
            for line in page.lines
            if line.text.strip() and _in_margin(line, page.height)
        }
        for text in normalized:
            counts[text] = counts.get(text, 0) + 1

    limit = threshold * len(pages)
    return {text for text, count in counts.items() if count >= limit}


def _filter_lines(page: ExtractedPage, repeated_margins: set[str]) -> list[RawLine]:
    kept: list[RawLine] = []
    for line in page.lines:
        trimmed = line.text.strip()
        if not trimmed:
            continue
        if _in_margin(line, page.height):
            if PAGE_NUMBER_RE.match(trimmed):
                continue
            if _normalize_margin_text(trimmed) in repeated_margins:
                continue
        kept.append(line)
    return sorted(kept, key=lambda line: (round(line.y0, 1), line.x0))


def _ends_paragraph(text: str) -> bool:
    stripped = text.strip().rstrip(_TRAILING_CLOSERS)
    return bool(stripped) and stripped[-1] in _TERMINAL_PUNCTUATION


def _starts_new_block(
    lines: list[RawLine],
    indices: list[int],
    index: int,
    left_margin: float,
    gap_limit: float,
    indent_limit: float,
) -> bool:
    first = lines[indices[0]]
    previous = lines[indices[-1]]
    line = lines[index]

    if line.y0 - previous.y1 > gap_limit:
        return True
    if first.font_size > 0 and abs(line.font_size - first.font_size) / first.font_size > 0.15:
        return True
    if line.x0 - left_margin >= indent_limit:
        return True
    # A sentence that ends on this line closes the paragraph. Without this
    # rule back-to-back paragraphs with identical indentation and leading
    # would be merged, because their line gap looks like ordinary wrapping.
    if _ends_paragraph(previous.text):
        return True
    return False


def _line_cells(line: RawLine) -> list[str]:
    # ``RawLine`` has no per-run geometry. Extraction encodes the wide gap
    # between table cells (>= 2 * body points) as a run of two or more spaces,
    # which is the signal used here.
    return [cell for cell in _TABLE_GAP_RE.split(line.text.strip()) if cell]


def _is_table(lines: list[RawLine]) -> bool:
    rows = [cells for cells in (_line_cells(line) for line in lines) if len(cells) >= 3]
    if len(rows) < 3:
        return False
    cells = [cell for row in rows for cell in row]
    digit_cells = sum(1 for cell in cells if any(char.isdigit() for char in cell))
    return digit_cells * 2 >= len(cells)


def _is_formula(text: str) -> bool:
    if len(text) >= 120 or any(char in text for char in _FORMULA_BAN):
        return False
    return sum(1 for symbol in _FORMULA_SYMBOLS if symbol in text) >= 2


def _classify(lines: list[RawLine], text: str, body: float) -> tuple[str, int | None]:
    size = lines[0].font_size
    if _is_table(lines):
        return "table", None
    if _is_formula(text):
        return "formula", None
    if size >= 1.2 * body and (len(text) <= 80 or any(line.bold for line in lines)):
        if size >= 1.6 * body:
            return "heading", 1
        if size >= 1.35 * body:
            return "heading", 2
        return "heading", 3
    return "paragraph", None


def _block_confidence(lines: list[RawLine]) -> float | None:
    values = [line.confidence for line in lines if line.confidence is not None]
    if not values:
        return None
    return sum(values) / len(values)


def lines_to_blocks(page: ExtractedPage, repeated_margins: set[str]) -> list[Block]:
    """Group the page's raw lines into classified, normalized blocks."""
    lines = _filter_lines(page, repeated_margins)
    if not lines:
        return []

    body = body_font_size(lines)
    median_h = median_line_height(lines)
    gap_limit = 1.6 * max(median_h, 0.8 * body)
    left_margin = min(line.x0 for line in lines)
    indent_limit = 1.5 * body

    groups: list[list[int]] = []
    current: list[int] = []
    for index in range(len(lines)):
        if current and _starts_new_block(
            lines, current, index, left_margin, gap_limit, indent_limit
        ):
            groups.append(current)
            current = [index]
        else:
            current.append(index)
    if current:
        groups.append(current)

    offsets: list[tuple[int, int]] = []
    cursor = 0
    for line in lines:
        start = cursor
        cursor += utf16_len(line.text)
        offsets.append((start, cursor))
        cursor += 1  # the newline that joins this line to the next one

    blocks: list[Block] = []
    for indices in groups:
        group_lines = [lines[index] for index in indices]
        text = merge_lines([line.text for line in group_lines])
        block_type, level = _classify(group_lines, text, body)
        block = Block(
            id="",
            type=block_type,
            rect=normalize_rect(
                min(line.x0 for line in group_lines),
                min(line.y0 for line in group_lines),
                max(line.x1 for line in group_lines),
                max(line.y1 for line in group_lines),
                page.width,
                page.height,
            ),
            text=text,
            level=level,
            confidence=_block_confidence(group_lines),
        )
        if block_type in ("heading", "paragraph"):
            block.source_char_start = offsets[indices[0]][0]
            block.source_char_end = offsets[indices[-1]][1]
        blocks.append(block)

    blocks.sort(key=lambda block: (block.rect["y"], block.rect["x"]))
    for position, block in enumerate(blocks):
        block.id = f"p{page.page}-b{position}"
    return blocks

"""Validate ``*.bookr.json`` packs against the shared TypeScript contract.

This mirrors ``packages/shared/src/schemas/reflow.ts`` using only the standard
library, so the Python tool never emits a pack the server would reject. As in
Zod, validation collects every violation instead of stopping at the first one.
"""

from __future__ import annotations

import math
import re
from datetime import datetime

from .model import utf16_len

REFLOW_PACK_SCHEMA_VERSION = 1
MAX_REFLOW_PAGES = 5000
MAX_REFLOW_BLOCKS = 200000
MAX_REFLOW_BLOCKS_PER_PAGE = 2000
MAX_REFLOW_TEXT_LENGTH = 20000
REFLOW_BLOCK_TYPES = ("heading", "paragraph", "image", "table", "formula", "fallback")

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class PackValidationError(Exception):
    """Carries every schema violation found in a pack."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = list(errors)
        super().__init__("; ".join(self.errors) if self.errors else "invalid reflow pack")


def _is_int(value: object) -> bool:
    """Number.isInteger semantics: integral values, but never booleans."""
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and float(value).is_integer()
    )


def _is_number(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and utf16_len(value) >= 1


def _is_datetime(value: object) -> bool:
    if not isinstance(value, str) or not _DATETIME_RE.match(value):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _check_int_in_range(
    value: object,
    minimum: int,
    maximum: int,
    message: str,
    errors: list[str],
) -> bool:
    if not _is_int(value) or not minimum <= value <= maximum:
        errors.append(message)
        return False
    return True


def _check_rect(rect: object, page: int, block_id: str, errors: list[str]) -> None:
    keys = ("x", "y", "w", "h")
    if not isinstance(rect, dict) or any(not _is_number(rect.get(key)) for key in keys):
        errors.append(
            f"rect must be an object with numeric x, y, w, h on page {page} block {block_id}"
        )
        return
    if any(not 0 <= rect[key] <= 1 for key in keys):
        errors.append(f"rect out of bounds on page {page} block {block_id}")
        return
    if rect["x"] + rect["w"] > 1:
        errors.append(
            f"rect x + w must not exceed 1 on page {page} block {block_id}"
        )
    if rect["y"] + rect["h"] > 1:
        errors.append(
            f"rect y + h must not exceed 1 on page {page} block {block_id}"
        )


def _validate_block(
    block: object,
    page: int,
    index: int,
    errors: list[str],
) -> str | None:
    """Validate one block; return its id when it is a duplicate candidate."""
    if not isinstance(block, dict):
        errors.append(f"page {page} block {index} must be an object")
        return None

    block_type = block.get("type")
    display_id = block.get("id")
    if not isinstance(display_id, str) or not 1 <= utf16_len(display_id) <= 64:
        errors.append(
            f"page {page} block {index} id must be a string of 1 to 64 UTF-16 code units"
        )
    if not isinstance(block_type, str) or block_type not in REFLOW_BLOCK_TYPES:
        errors.append(f"unsupported block type {block_type!r} on page {page}")

    if "text" in block:
        text = block["text"]
        if not isinstance(text, str):
            errors.append(f"block text must be a string on page {page}")
        elif utf16_len(text) > MAX_REFLOW_TEXT_LENGTH:
            errors.append(
                f"block text must be at most {MAX_REFLOW_TEXT_LENGTH} UTF-16 "
                f"code units on page {page}"
            )
    elif block_type in ("heading", "paragraph"):
        errors.append(f"{block_type} blocks require text")

    if "level" in block:
        level = block["level"]
        if not (_is_int(level) and 1 <= level <= 6):
            errors.append(f"block level must be an integer between 1 and 6 on page {page}")
    elif block_type == "heading":
        errors.append("heading blocks require a level")

    _check_rect(block.get("rect"), page, str(display_id), errors)

    start = block.get("sourceCharStart")
    end = block.get("sourceCharEnd")
    if "sourceCharStart" in block and not (_is_int(start) and start >= 0):
        errors.append(f"sourceCharStart must be an integer >= 0 on page {page}")
    if "sourceCharEnd" in block and not (_is_int(end) and end >= 0):
        errors.append(f"sourceCharEnd must be an integer >= 0 on page {page}")
    if (
        _is_int(start)
        and start >= 0
        and _is_int(end)
        and end >= 0
        and end < start
    ):
        errors.append(f"sourceCharEnd must not precede sourceCharStart on page {page}")

    return display_id if isinstance(display_id, str) else None


def _validate_page(page: object, index: int, errors: list[str]) -> int:
    """Validate one page; return its block count for the pack-wide limit."""
    number = index + 1
    if not isinstance(page, dict):
        errors.append(f"page {number} must be an object")
        return 0

    page_value = page.get("page")
    if not _is_int(page_value) or page_value < 1:
        errors.append(f"page {number} page must be an integer >= 1")
    elif page_value != number:
        errors.append("pages must be numbered 1..n in order")

    for key in ("width", "height"):
        value = page.get(key)
        if not _is_number(value) or value <= 0:
            errors.append(f"page {number} {key} must be a positive number")

    blocks = page.get("blocks")
    if not isinstance(blocks, list):
        errors.append(f"page {number} blocks must be an array")
        return 0
    if len(blocks) > MAX_REFLOW_BLOCKS_PER_PAGE:
        errors.append(
            f"page {number} must contain at most "
            f"{MAX_REFLOW_BLOCKS_PER_PAGE} blocks"
        )

    seen: set[str] = set()
    for block_index, block in enumerate(blocks):
        block_id = _validate_block(block, number, block_index, errors)
        if block_id is None:
            continue
        if block_id in seen:
            errors.append(f"duplicate block id {block_id} on page {number}")
        seen.add(block_id)
    return len(blocks)


def _validate_source(source: object, errors: list[str]) -> None:
    if not isinstance(source, dict):
        errors.append("source must be an object")
        return
    sha256 = source.get("sha256")
    if not isinstance(sha256, str) or not _SHA256_RE.match(sha256):
        errors.append("source.sha256 must be 64 lowercase hex characters")
    _check_int_in_range(
        source.get("pageCount"),
        1,
        MAX_REFLOW_PAGES,
        f"source.pageCount must be an integer between 1 and {MAX_REFLOW_PAGES}",
        errors,
    )


def _validate_tool(tool: object, errors: list[str]) -> None:
    if not isinstance(tool, dict):
        errors.append("tool must be an object")
        return
    if not _is_non_empty_string(tool.get("name")):
        errors.append("tool.name must be a non-empty string")
    if not _is_non_empty_string(tool.get("version")):
        errors.append("tool.version must be a non-empty string")


def _validate_page_list(
    values: object,
    field: str,
    errors: list[str],
) -> None:
    if not isinstance(values, list):
        errors.append(f"quality.{field} must be an array")
        return
    if len(values) > MAX_REFLOW_PAGES:
        errors.append(
            f"quality.{field} must contain at most {MAX_REFLOW_PAGES} entries"
        )
    if any(not (_is_int(value) and value >= 1) for value in values):
        errors.append(f"quality.{field} must contain only integers >= 1")


def _validate_quality(quality: object, errors: list[str]) -> None:
    if not isinstance(quality, dict):
        errors.append("quality must be an object")
        return
    _check_int_in_range(
        quality.get("pages"),
        0,
        MAX_REFLOW_PAGES,
        f"quality.pages must be an integer between 0 and {MAX_REFLOW_PAGES}",
        errors,
    )
    _check_int_in_range(
        quality.get("textBlocks"),
        0,
        MAX_REFLOW_BLOCKS,
        f"quality.textBlocks must be an integer between 0 and {MAX_REFLOW_BLOCKS}",
        errors,
    )
    _validate_page_list(quality.get("fallbackPages"), "fallbackPages", errors)
    _validate_page_list(quality.get("ocrPages"), "ocrPages", errors)

    if "avgConfidence" not in quality:
        errors.append("quality.avgConfidence must be null or a number between 0 and 1")
    else:
        average = quality["avgConfidence"]
        if average is not None and not (_is_number(average) and 0 <= average <= 1):
            errors.append(
                "quality.avgConfidence must be null or a number between 0 and 1"
            )

    warnings = quality.get("warnings")
    if not isinstance(warnings, list) or any(
        not isinstance(warning, str) for warning in warnings
    ):
        errors.append("quality.warnings must be an array of strings")


def _validate_toc(toc: object, errors: list[str]) -> None:
    if not isinstance(toc, list):
        errors.append("toc must be an array")
        return
    for index, entry in enumerate(toc):
        if not isinstance(entry, dict):
            errors.append(f"toc[{index}] must be an object")
            continue
        if not _is_non_empty_string(entry.get("label")):
            errors.append(f"toc[{index}].label must be a non-empty string")
        page = entry.get("page")
        if not (_is_int(page) and page >= 1):
            errors.append(f"toc[{index}].page must be an integer >= 1")
        level = entry.get("level")
        if not (_is_int(level) and 1 <= level <= 6):
            errors.append(f"toc[{index}].level must be an integer between 1 and 6")


def validate_pack(pack: dict) -> list[str]:
    """Return every violation found in *pack*; an empty list means valid."""
    errors: list[str] = []
    if not isinstance(pack, dict):
        return ["pack must be an object"]

    version = pack.get("schemaVersion")
    if not _is_int(version) or version != REFLOW_PACK_SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {REFLOW_PACK_SCHEMA_VERSION}")

    _validate_source(pack.get("source"), errors)

    if not _is_datetime(pack.get("generatedAt")):
        errors.append("generatedAt must be an ISO 8601 UTC timestamp ending in Z")

    _validate_tool(pack.get("tool"), errors)
    _validate_quality(pack.get("quality"), errors)
    _validate_toc(pack.get("toc"), errors)

    pages = pack.get("pages")
    if not isinstance(pages, list):
        errors.append("pages must be an array")
        return errors
    if not 1 <= len(pages) <= MAX_REFLOW_PAGES:
        errors.append(
            f"pages must contain between 1 and {MAX_REFLOW_PAGES} entries"
        )

    source = pack.get("source")
    if isinstance(source, dict):
        page_count = source.get("pageCount")
        if _is_int(page_count) and page_count != len(pages):
            errors.append("pages.length must equal source.pageCount")

    block_count = 0
    for index, page in enumerate(pages):
        block_count += _validate_page(page, index, errors)

    if block_count > MAX_REFLOW_BLOCKS:
        errors.append(f"packs may contain at most {MAX_REFLOW_BLOCKS} blocks")

    return errors

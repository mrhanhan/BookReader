"""Local PDF preprocessing: turn books into ``*.bookr.json`` reflow packs."""

from .detect import has_usable_text_layer
from .layout import (
    body_font_size,
    lines_to_blocks,
    median_line_height,
    merge_lines,
    repeated_margin_texts,
)
from .model import (
    TOOL_NAME,
    Block,
    ExtractedPage,
    OcrBackend,
    OcrLine,
    RawLine,
    ReflowPack,
    TextCorrector,
    normalize_rect,
    utf16_len,
)
from .quality import build_quality
from .schema import PackValidationError, validate_pack

__version__ = "0.1.0"

__all__ = [
    "TOOL_NAME",
    "Block",
    "ExtractedPage",
    "OcrBackend",
    "OcrLine",
    "PackValidationError",
    "RawLine",
    "ReflowPack",
    "TextCorrector",
    "body_font_size",
    "build_quality",
    "has_usable_text_layer",
    "lines_to_blocks",
    "median_line_height",
    "merge_lines",
    "normalize_rect",
    "repeated_margin_texts",
    "utf16_len",
    "validate_pack",
]

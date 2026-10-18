"""Data model shared by the extraction, layout and validation layers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

TOOL_NAME = "bookr-preprocess"


def utf16_len(text: str) -> int:
    """Count UTF-16 code units, the unit the shared pack contract uses.

    JavaScript indexes strings by UTF-16 code unit, so lengths and source
    offsets must be measured the same way on the Python side.
    """
    return sum(2 if ord(char) > 0xFFFF else 1 for char in text)


def normalize_rect(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    width: float,
    height: float,
) -> dict[str, float]:
    """Clamp a point-space rectangle and normalize it to the unit square.

    Values are rounded to six decimals, matching the precision used by the
    reader for locator rectangles. Rounding can push ``x + w`` a hair past 1,
    so the width and height are capped to keep the rect valid.
    """
    if width <= 0 or height <= 0:
        raise ValueError("page width and height must be positive")

    left = min(max(x0, 0.0), float(width))
    top = min(max(y0, 0.0), float(height))
    right = min(max(x1, 0.0), float(width))
    bottom = min(max(y1, 0.0), float(height))

    x = round(left / width, 6)
    y = round(top / height, 6)
    w = round(max(0.0, right - left) / width, 6)
    h = round(max(0.0, bottom - top) / height, 6)
    return {
        "x": x,
        "y": y,
        "w": max(0.0, min(w, round(1.0 - x, 6))),
        "h": max(0.0, min(h, round(1.0 - y, 6))),
    }


@dataclass(frozen=True)
class RawLine:
    """One physical text line in PDF points, origin at the top-left."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    font_size: float
    bold: bool = False
    confidence: float | None = None


@dataclass
class ExtractedPage:
    page: int
    width: float
    height: float
    lines: list[RawLine]
    image_rects: list[tuple[float, float, float, float]] = field(default_factory=list)
    text_chars: int = 0
    ocr: bool = False
    warnings: list[str] = field(default_factory=list)


@dataclass
class Block:
    id: str
    type: str
    rect: dict[str, float]
    text: str | None = None
    level: int | None = None
    source_char_start: int | None = None
    source_char_end: int | None = None
    confidence: float | None = None

    def to_dict(self) -> dict:
        """Serialize using the camelCase keys of the shared reflow schema.

        ``confidence`` is deliberately omitted: it is tool-internal metadata
        used to build ``quality.avgConfidence`` and is not part of the wire
        contract, so packs stay exactly as the TypeScript schema expects.
        """
        data: dict = {"id": self.id, "type": self.type, "rect": dict(self.rect)}
        if self.text is not None:
            data["text"] = self.text
        if self.level is not None:
            data["level"] = self.level
        if self.source_char_start is not None:
            data["sourceCharStart"] = self.source_char_start
        if self.source_char_end is not None:
            data["sourceCharEnd"] = self.source_char_end
        return data


@dataclass
class OcrLine:
    """One recognized line; coordinates are normalized to the page (0..1)."""

    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    confidence: float


class OcrBackend(Protocol):
    def recognize(self, png: bytes, lang: str) -> list[OcrLine]: ...


class TextCorrector(Protocol):
    def correct(self, text: str) -> str: ...


@dataclass
class ReflowPack:
    schema_version: int
    source_sha256: str
    page_count: int
    generated_at: str
    tool_version: str
    pages: list[dict]
    toc: list[dict]
    quality: dict

    def to_dict(self) -> dict:
        return {
            "schemaVersion": self.schema_version,
            "source": {"sha256": self.source_sha256, "pageCount": self.page_count},
            "generatedAt": self.generated_at,
            "tool": {"name": TOOL_NAME, "version": self.tool_version},
            "quality": self.quality,
            "toc": self.toc,
            "pages": self.pages,
        }

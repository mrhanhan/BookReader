"""PyMuPDF-backed extraction behind the ``PdfExtractor`` protocol.

The protocol keeps :mod:`bookr_preprocess.build` testable without a real PDF
library, and PyMuPDF itself is imported lazily so importing the package never
requires the optional native dependency.
"""

from __future__ import annotations

from typing import Any, Protocol

from .model import ExtractedPage, RawLine


class PdfExtractor(Protocol):
    """Geometry and text access the build pipeline needs from a PDF."""

    def page_count(self) -> int: ...

    def page_size(self, page: int) -> tuple[float, float]: ...

    def extract_page(self, page: int) -> ExtractedPage: ...

    def render_page_png(self, page: int, dpi: int) -> bytes: ...

    def outline(self) -> list[dict]: ...

    def close(self) -> None: ...


def _pymupdf() -> Any:
    try:
        import pymupdf
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError("PyMuPDF is required: pip install pymupdf") from exc
    return pymupdf


def _span_bbox(span: dict) -> tuple[float, float, float, float] | None:
    bbox = span.get("bbox")
    if not bbox or len(bbox) < 4:
        return None
    return (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))


def _join_spans(spans: list[dict]) -> str:
    """Join a PyMuPDF line's spans, marking wide column gaps with two spaces.

    The layout heuristic detects tables from runs of two or more spaces, so a
    horizontal gap of at least 1.5x the smaller span size becomes ``'  '``.
    Anything narrower is concatenated as-is: glyph-level spans carry their own
    spaces, and inserting more would corrupt ordinary prose.
    """
    parts: list[str] = []
    previous_bbox: tuple[float, float, float, float] | None = None
    previous_size = 0.0

    for span in spans:
        text = span.get("text", "")
        if not text:
            continue
        bbox = _span_bbox(span)
        size = float(span.get("size", 0.0) or 0.0)
        if parts and bbox is not None and previous_bbox is not None:
            gap = bbox[0] - previous_bbox[2]
            threshold = 1.5 * min(previous_size, size)
            if threshold > 0 and gap >= threshold:
                parts.append("  ")
        parts.append(text)
        if bbox is not None:
            previous_bbox = bbox
            previous_size = size

    return "".join(parts).strip()


def _union_bbox(spans: list[dict]) -> tuple[float, float, float, float] | None:
    boxes = [box for box in (_span_bbox(span) for span in spans) if box is not None]
    if not boxes:
        return None
    return (
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )


def _span_is_bold(span: dict) -> bool:
    font = str(span.get("font") or "")
    flags = int(span.get("flags") or 0)
    return "Bold" in font or bool(flags & 16)


class PyMuPdfExtractor:
    """``PdfExtractor`` implementation backed by PyMuPDF."""

    def __init__(self, path: str) -> None:
        self._pymupdf = _pymupdf()
        self._doc = self._pymupdf.open(path)

    def page_count(self) -> int:
        return len(self._doc)

    def _page(self, page: int) -> Any:
        if not 1 <= page <= len(self._doc):
            raise IndexError(f"page {page} out of range")
        return self._doc[page - 1]

    def page_size(self, page: int) -> tuple[float, float]:
        rect = self._page(page).rect
        return (float(rect.width), float(rect.height))

    def extract_page(self, page: int) -> ExtractedPage:
        pdf_page = self._page(page)
        # ``page.rect`` is the displayed (post-rotation) size while PyMuPDF's
        # text and image rectangles stay in unrotated page space; rotate them
        # so every rectangle the pack carries shares the displayed space.
        width = float(pdf_page.rect.width)
        height = float(pdf_page.rect.height)
        rotation = pdf_page.rotation_matrix

        lines: list[RawLine] = []
        data = pdf_page.get_text("dict")
        for block in data.get("blocks", []):
            if block.get("type") != 0:
                continue
            for pdf_line in block.get("lines", []):
                spans = pdf_line.get("spans") or []
                text = _join_spans(spans)
                if not text:
                    continue
                bbox = _union_bbox(spans) or tuple(pdf_line.get("bbox") or ())
                if len(bbox) < 4:
                    continue
                rect = self._pymupdf.Rect(bbox) * rotation
                sizes = [float(span.get("size", 0.0) or 0.0) for span in spans]
                font_size = max(sizes, default=0.0) or 10.0
                lines.append(
                    RawLine(
                        text=text,
                        x0=float(rect.x0),
                        y0=float(rect.y0),
                        x1=float(rect.x1),
                        y1=float(rect.y1),
                        font_size=font_size,
                        bold=any(_span_is_bold(span) for span in spans),
                    )
                )

        return ExtractedPage(
            page=page,
            width=width,
            height=height,
            lines=lines,
            image_rects=self._image_rects(pdf_page),
            text_chars=len(pdf_page.get_text("text").strip()),
        )

    def _image_rects(
        self, pdf_page: Any
    ) -> list[tuple[float, float, float, float]]:
        page_area = pdf_page.rect.width * pdf_page.rect.height
        minimum_area = 0.01 * page_area
        rotation = pdf_page.rotation_matrix
        seen: set[tuple[float, float, float, float]] = set()
        rects: list[tuple[float, float, float, float]] = []
        for image in pdf_page.get_images(full=True):
            xref = image[0]
            try:
                placements = pdf_page.get_image_rects(xref)
            except Exception:  # noqa: BLE001 - a broken image must not fail a page
                continue
            for placed in placements:
                rect = placed * rotation
                if rect.is_empty or rect.width <= 0 or rect.height <= 0:
                    continue
                if rect.width * rect.height < minimum_area:
                    continue
                value = (
                    float(rect.x0),
                    float(rect.y0),
                    float(rect.x1),
                    float(rect.y1),
                )
                key = tuple(round(part, 2) for part in value)
                if key in seen:
                    continue
                seen.add(key)
                rects.append(value)
        return rects

    def render_page_png(self, page: int, dpi: int) -> bytes:
        pixmap = self._page(page).get_pixmap(dpi=dpi, alpha=False)
        return pixmap.tobytes("png")

    def outline(self) -> list[dict]:
        entries: list[dict] = []
        for level, title, page in self._doc.get_toc(simple=True):
            try:
                page_number = int(page)
                level_number = int(level)
            except (TypeError, ValueError):
                continue
            if page_number < 1:
                continue
            entries.append(
                {
                    "label": str(title),
                    "page": page_number,
                    "level": level_number,
                }
            )
        return entries

    def close(self) -> None:
        self._doc.close()

    def __enter__(self) -> "PyMuPdfExtractor":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

"""Build a ``*.bookr.json`` reflow pack from extracted PDF pages.

The pipeline is intentionally linear: extract geometry and text, OCR the
pages that need it, group lines into blocks, add image blocks, and finally
validate the pack against the shared contract before anyone can upload it.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

from . import __version__
from .detect import has_usable_text_layer
from .extract_text import PdfExtractor
from .layout import lines_to_blocks, repeated_margin_texts
from .model import (
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
from .pdf_writer import write_text_layer_pdf
from .quality import build_quality
from .schema import REFLOW_PACK_SCHEMA_VERSION, PackValidationError, validate_pack

# Pages with fewer characters than this are candidates for OCR when they also
# contain an image; a scanned page has no text layer at all.
OCR_AUTO_CHARS = 100
FALLBACK_TOC_HEADINGS = 50
_OCR_FONT_RATIO = 0.75


@dataclass
class BuildOptions:
    ocr: str = "auto"  # auto | always | never
    ocr_lang: str = "ch"
    dpi: int = 300
    ai_correct: bool = False
    title: str | None = None
    text_pdf: str | None = None
    max_pages: int | None = None


@dataclass
class BuildResult:
    pack: ReflowPack
    pack_dict: dict
    report: dict
    ocr_lines: dict[int, list[RawLine]]
    warnings: list[str]


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _utc_timestamp() -> str:
    """Current UTC time with milliseconds and the ``Z`` suffix the schema wants."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _page_text_chars(page: ExtractedPage) -> int:
    if page.text_chars is not None:
        return page.text_chars
    return sum(utf16_len(line.text) for line in page.lines)


def _needs_ocr(page: ExtractedPage, mode: str) -> bool:
    if mode == "always":
        return True
    if mode == "never":
        return False
    return _page_text_chars(page) < OCR_AUTO_CHARS and bool(page.image_rects)


def _convert_ocr_lines(page: ExtractedPage, lines: list[OcrLine]) -> list[RawLine]:
    """Map normalized OCR boxes back into page points, top-to-bottom."""
    converted: list[RawLine] = []
    for entry in lines:
        text = entry.text.strip()
        if not text:
            continue
        height = max(0.0, (entry.y1 - entry.y0) * page.height)
        converted.append(
            RawLine(
                text=text,
                x0=entry.x0 * page.width,
                y0=entry.y0 * page.height,
                x1=entry.x1 * page.width,
                y1=entry.y1 * page.height,
                font_size=max(4.0, _OCR_FONT_RATIO * height),
                confidence=entry.confidence,
            )
        )
    converted.sort(key=lambda line: (line.y0, line.x0))
    return converted


def _image_covered(
    image_rect: tuple[float, float, float, float],
    page: ExtractedPage,
    blocks: list[Block],
) -> bool:
    """True when a text block covers at least half of the image area."""
    normalized = normalize_rect(*image_rect, page.width, page.height)
    area = normalized["w"] * normalized["h"]
    if area <= 0:
        return False
    for block in blocks:
        rect = block.rect
        overlap_w = max(
            0.0,
            min(normalized["x"] + normalized["w"], rect["x"] + rect["w"])
            - max(normalized["x"], rect["x"]),
        )
        overlap_h = max(
            0.0,
            min(normalized["y"] + normalized["h"], rect["y"] + rect["h"])
            - max(normalized["y"], rect["y"]),
        )
        if overlap_w * overlap_h >= 0.5 * area:
            return True
    return False


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _sanitize_outline(entries: list[dict], page_count: int) -> list[dict]:
    toc: list[dict] = []
    for entry in entries:
        label = str(entry.get("label", "")).strip()
        page = _as_int(entry.get("page"))
        level = _as_int(entry.get("level")) or 1
        if not label or page is None or not 1 <= page <= page_count:
            continue
        toc.append({"label": label, "page": page, "level": min(max(level, 1), 6)})
    return toc


def _headings_toc(
    pages: list[ExtractedPage],
    blocks_by_page: dict[int, list[Block]],
) -> list[dict]:
    """First headings in reading order, used when the PDF has no outline."""
    toc: list[dict] = []
    for page in sorted(pages, key=lambda value: value.page):
        for block in blocks_by_page.get(page.page, []):
            if block.type != "heading" or not block.text:
                continue
            toc.append(
                {
                    "label": block.text,
                    "page": page.page,
                    "level": min(max(block.level or 1, 1), 6),
                }
            )
            if len(toc) >= FALLBACK_TOC_HEADINGS:
                return toc
    return toc


def _apply_corrections(
    blocks_by_page: dict[int, list[Block]],
    corrector: TextCorrector,
    warnings: list[str],
) -> None:
    for number in sorted(blocks_by_page):
        for index, block in enumerate(blocks_by_page[number]):
            if block.type not in ("heading", "paragraph") or block.text is None:
                continue
            try:
                corrected = corrector.correct(block.text)
            except Exception as exc:  # noqa: BLE001 - keep the original on failure
                warnings.append(
                    f"第 {number} 页第 {index + 1} 块纠错失败（{type(exc).__name__}）"
                )
                continue
            if isinstance(corrected, str):
                # Source offsets still index the uncorrected text: highlight
                # mapping inside a corrected block is block-approximate.
                block.text = corrected


def build_pack(
    *,
    source_path: str,
    extractor: PdfExtractor,
    options: BuildOptions,
    ocr_backend: OcrBackend | None = None,
    corrector: TextCorrector | None = None,
) -> BuildResult:
    if options.ocr not in ("auto", "always", "never"):
        raise ValueError(f"unsupported OCR mode: {options.ocr}")

    warnings: list[str] = []
    ocr_lines: dict[int, list[RawLine]] = {}
    ocr_pages: list[int] = []
    fallback_pages: list[int] = []
    forced_fallback: set[int] = set()

    source_sha256 = _sha256_file(source_path)

    page_count = extractor.page_count()
    if options.max_pages is not None:
        # Debug-only convenience: build a prefix so heuristics can be tested
        # quickly on a large book.
        page_count = min(page_count, max(0, options.max_pages))
    if page_count < 1:
        raise PackValidationError(["pages must contain between 1 and 5000 entries"])

    pages: list[ExtractedPage] = []
    for number in range(1, page_count + 1):
        try:
            page = extractor.extract_page(number)
        except Exception as exc:  # noqa: BLE001 - one bad page must not stop the book
            warnings.append(f"第 {number} 页提取失败（{type(exc).__name__}）")
            try:
                width, height = extractor.page_size(number)
            except Exception:  # noqa: BLE001
                width, height = 612.0, 792.0
            page = ExtractedPage(
                page=number,
                width=width,
                height=height,
                lines=[],
                text_chars=0,
            )
        page.page = number
        pages.append(page)

    usable = has_usable_text_layer(pages)
    if not usable and options.ocr == "never":
        warnings.append("PDF 没有足够的文本层，建议启用 OCR")

    for page in pages:
        if not _needs_ocr(page, options.ocr):
            continue
        if ocr_backend is None:
            warnings.append(f"第 {page.page} 页需要 OCR，但没有可用的 OCR 后端")
            page.lines = []
            page.ocr = False
            forced_fallback.add(page.page)
            continue
        try:
            png = extractor.render_page_png(page.page, options.dpi)
            recognized = ocr_backend.recognize(png, options.ocr_lang)
        except Exception as exc:  # noqa: BLE001 - fall back to a page crop
            warnings.append(f"第 {page.page} 页 OCR 失败（{type(exc).__name__}）")
            page.lines = []
            page.ocr = False
            forced_fallback.add(page.page)
            continue
        page.lines = _convert_ocr_lines(page, recognized)
        page.ocr = True
        page.text_chars = len("".join(line.text for line in page.lines).strip())
        ocr_pages.append(page.page)
        if page.lines:
            ocr_lines[page.page] = page.lines

    repeated = repeated_margin_texts(pages)
    blocks_by_page: dict[int, list[Block]] = {}
    for page in pages:
        page_blocks = lines_to_blocks(page, repeated)

        if not page.ocr and page.page not in forced_fallback:
            seen_images: set[tuple[float, float, float, float]] = set()
            for image_rect in page.image_rects:
                key = tuple(round(part, 2) for part in image_rect)
                if key in seen_images:
                    continue
                seen_images.add(key)
                if _image_covered(image_rect, page, page_blocks):
                    continue
                rect = normalize_rect(*image_rect, page.width, page.height)
                if rect["w"] <= 0 or rect["h"] <= 0:
                    continue
                page_blocks.append(Block(id="", type="image", rect=rect))
            page_blocks.sort(key=lambda block: (block.rect["y"], block.rect["x"]))

        if not page_blocks:
            page_blocks = [
                Block(
                    id="",
                    type="fallback",
                    rect={"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0},
                )
            ]
            fallback_pages.append(page.page)

        for index, block in enumerate(page_blocks):
            block.id = f"p{page.page}-b{index}"
        blocks_by_page[page.page] = page_blocks

    if options.ai_correct and corrector is not None:
        _apply_corrections(blocks_by_page, corrector, warnings)

    try:
        outline = extractor.outline()
    except Exception as exc:  # noqa: BLE001 - headings still make a usable TOC
        warnings.append(f"目录读取失败（{type(exc).__name__}）")
        outline = []
    toc = _sanitize_outline(outline, page_count)
    if not toc:
        toc = _headings_toc(pages, blocks_by_page)

    quality = build_quality(
        pages,
        blocks_by_page,
        fallback_pages,
        ocr_pages,
        warnings,
    )
    pack = ReflowPack(
        schema_version=REFLOW_PACK_SCHEMA_VERSION,
        source_sha256=source_sha256,
        page_count=len(pages),
        generated_at=_utc_timestamp(),
        tool_version=__version__,
        pages=[
            {
                "page": page.page,
                "width": page.width,
                "height": page.height,
                "blocks": [block.to_dict() for block in blocks_by_page[page.page]],
            }
            for page in pages
        ],
        toc=toc,
        quality=quality,
    )
    pack_dict = pack.to_dict()
    if options.title:
        pack_dict["title"] = options.title

    errors = validate_pack(pack_dict)
    if errors:
        raise PackValidationError(errors)

    if options.text_pdf and ocr_lines:
        write_text_layer_pdf(source_path, options.text_pdf, ocr_lines)

    report = dict(quality)
    report.update(
        {
            "source": source_path,
            "outputPages": len(pages),
            "textPdf": options.text_pdf,
        }
    )

    return BuildResult(
        pack=pack,
        pack_dict=pack_dict,
        report=report,
        ocr_lines=ocr_lines,
        warnings=warnings,
    )

"""Quality metadata embedded in every reflow pack."""

from __future__ import annotations

from .model import Block, ExtractedPage


def build_quality(
    pages: list[ExtractedPage],
    blocks_by_page: dict[int, list[Block]],
    fallback_pages: list[int],
    ocr_pages: list[int],
    warnings: list[str],
) -> dict:
    """Summarize coverage, OCR usage and confidence for a pack.

    Confidence comes from OCR line confidences, the rawest signal; block
    confidences are used as a fallback when pages do not carry any.
    """
    blocks = [block for page_blocks in blocks_by_page.values() for block in page_blocks]
    confidences = [
        line.confidence
        for page in pages
        for line in page.lines
        if line.confidence is not None
    ]
    if not confidences:
        confidences = [block.confidence for block in blocks if block.confidence is not None]

    average = round(sum(confidences) / len(confidences), 3) if confidences else None
    return {
        "pages": len(pages),
        "textBlocks": sum(
            1 for block in blocks if block.type in ("heading", "paragraph")
        ),
        "fallbackPages": sorted(set(fallback_pages)),
        "ocrPages": sorted(set(ocr_pages)),
        "avgConfidence": average,
        "warnings": list(warnings[:100]),
    }

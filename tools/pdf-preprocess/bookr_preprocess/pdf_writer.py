"""Write an invisible OCR text layer over the original PDF."""

from __future__ import annotations

from .model import RawLine


def _pymupdf():
    try:
        import pymupdf
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError("PyMuPDF is required: pip install pymupdf") from exc
    return pymupdf


def _line_fontname(text: str) -> str:
    # PyMuPDF bundles CJK fonts; the built-in 'helv' only covers Latin.
    return "china-s" if any(ord(char) > 127 for char in text) else "helv"


def write_text_layer_pdf(
    source_path: str,
    output_path: str,
    ocr_lines: dict[int, list[RawLine]],
) -> int:
    """Insert invisible OCR text into *source_path* and save to *output_path*.

    Returns the number of successfully inserted lines. Font or glyph failures
    are skipped line by line so one bad line does not lose the whole layer.
    """
    pymupdf = _pymupdf()
    document = pymupdf.open(source_path)
    inserted = 0
    try:
        for page_number in sorted(ocr_lines):
            if not 1 <= page_number <= len(document):
                continue
            page = document[page_number - 1]
            # OCR lines come from the rendered (displayed) page, while
            # ``insert_text`` writes in the unrotated page space.
            derotation = page.derotation_matrix
            for line in ocr_lines[page_number]:
                text = line.text.strip()
                if not text:
                    continue
                height = max(0.1, line.y1 - line.y0)
                point = pymupdf.Point(
                    line.x0, line.y1 - 0.2 * height
                ) * derotation
                try:
                    page.insert_text(
                        point,
                        text,
                        fontsize=max(4, 0.75 * height),
                        fontname=_line_fontname(text),
                        render_mode=3,  # invisible but selectable/searchable
                        color=(0, 0, 0),
                        # Glyphs are drawn in unrotated page space; rotate them
                        # so they run along the displayed (OCR) line.
                        rotate=page.rotation,
                    )
                except Exception:  # noqa: BLE001 - skip an unrenderable line
                    continue
                inserted += 1
        document.save(output_path, garbage=1, deflate=True)
    finally:
        document.close()
    return inserted

"""Optional PaddleOCR backend used when a PDF page has no usable text layer."""

from __future__ import annotations

from io import BytesIO
from typing import Callable, Iterator

from .model import OcrLine

_MISSING_DEPENDENCIES = "OCR dependencies missing: pip install -e '.[ocr]'"

Decoder = Callable[[bytes], tuple[object, int, int]]


def _score(value: object) -> float:
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _normalize_box(
    box: object, width: int, height: int
) -> tuple[float, float, float, float] | None:
    """Return a normalized ``(x0, y0, x1, y1)`` rect, clamped to the page."""
    try:
        points = list(box)  # type: ignore[arg-type]
    except TypeError:
        return None
    xs: list[float] = []
    ys: list[float] = []
    for point in points:
        try:
            pair = list(point)  # type: ignore[arg-type]
        except TypeError:
            return None
        if len(pair) < 2:
            return None
        try:
            xs.append(float(pair[0]))
            ys.append(float(pair[1]))
        except (TypeError, ValueError):
            return None
    if not xs:
        return None

    def clamp(value: float, size: int) -> float:
        return round(min(max(value / size, 0.0), 1.0), 6)

    return (
        clamp(min(xs), width),
        clamp(min(ys), height),
        clamp(max(xs), width),
        clamp(max(ys), height),
    )


def _v2_entries(raw: object) -> Iterator[tuple[object, object, object]]:
    """Yield ``(text, box, score)`` from PaddleOCR 2.x list results."""
    if not isinstance(raw, list) or not raw:
        return
    first = raw[0]
    if not isinstance(first, list):
        return
    for entry in first:
        if not isinstance(entry, (list, tuple)) or len(entry) < 2:
            continue
        box, payload = entry[0], entry[1]
        score: object = 0.0
        if isinstance(payload, (list, tuple)):
            if not payload:
                continue
            text = payload[0]
            if len(payload) > 1:
                score = payload[1]
        else:
            text = payload
        yield text, box, score


def _v3_entries(raw: object) -> Iterator[tuple[object, object, object]]:
    """Yield ``(text, box, score)`` from PaddleOCR 3.x dict results."""
    if not isinstance(raw, list):
        return
    for result in raw:
        if not hasattr(result, "get"):
            continue
        texts = result.get("rec_texts")
        if texts is None:
            continue
        scores = result.get("rec_scores")
        if scores is None:
            scores = []
        polys = result.get("rec_polys")
        if polys is None:
            polys = result.get("dt_polys")
        if polys is None:
            continue
        for index, text in enumerate(texts):
            if index >= len(polys):
                break
            score = scores[index] if index < len(scores) else 0.0
            yield text, polys[index], score


def parse_paddle_result(raw: object, width: int, height: int) -> list[OcrLine]:
    """Convert a PaddleOCR result into normalized, top-to-bottom lines.

    Both the 2.x nested-list shape and the 3.x dict shape are accepted.
    Entries whose text is blank or whose box cannot be parsed are dropped.
    The result is sorted by ``(y0, x0)``.
    """
    if width <= 0 or height <= 0:
        raise ValueError("image width and height must be positive")

    lines: list[OcrLine] = []
    for text, box, score in (*_v2_entries(raw), *_v3_entries(raw)):
        if not isinstance(text, str) or not text.strip():
            continue
        rect = _normalize_box(box, width, height)
        if rect is None:
            continue
        x0, y0, x1, y1 = rect
        lines.append(
            OcrLine(
                text=text.strip(),
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
                confidence=_score(score),
            )
        )
    lines.sort(key=lambda line: (line.y0, line.x0))
    return lines


def _default_decoder(png: bytes) -> tuple[object, int, int]:
    try:
        import numpy as np
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError(_MISSING_DEPENDENCIES) from exc

    with Image.open(BytesIO(png)) as image:
        rgb = image.convert("RGB")
        return np.asarray(rgb), rgb.width, rgb.height


def _build_engine(lang: str) -> object:
    try:
        import numpy  # noqa: F401 - required by the default decoder
        from PIL import Image  # noqa: F401 - required by the default decoder
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPENDENCIES) from exc
    return PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)


class PaddleOcrBackend:
    """``OcrBackend`` implementation backed by PaddleOCR.

    The engine and the PNG decoder are injectable so tests (and callers with
    an alternate pipeline) do not need the optional dependencies installed.
    """

    def __init__(
        self,
        lang: str = "ch",
        engine: object | None = None,
        decoder: Decoder | None = None,
    ) -> None:
        self.lang = lang
        self._engine = engine if engine is not None else _build_engine(lang)
        self._decoder = decoder if decoder is not None else _default_decoder

    def recognize(self, png: bytes, lang: str) -> list[OcrLine]:
        """Recognize one PNG page; ``lang`` comes from the shared protocol.

        The engine is created with the language passed to ``__init__`` (the
        CLI always passes the same value to both).
        """
        image, width, height = self._decoder(png)
        raw = self._engine.ocr(image, cls=True)
        return parse_paddle_result(raw, width, height)

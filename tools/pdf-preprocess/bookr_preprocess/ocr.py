"""Optional PaddleOCR backend used when a PDF page has no usable text layer."""

from __future__ import annotations

import inspect
from io import BytesIO
from typing import Callable, Iterator

from .model import OcrLine

_MISSING_DEPENDENCIES = "OCR dependencies missing: pip install -e '.[ocr]'"
_ENGINE_ERRORS = (ImportError, OSError, TypeError, ValueError, RuntimeError)

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
        # PaddleOCR follows the cv2 convention and expects BGR channel order.
        pixels = np.ascontiguousarray(np.asarray(rgb)[:, :, ::-1])
        return pixels, rgb.width, rgb.height


def _is_paddle_v3(engine_or_class: object) -> bool:
    """True when the engine exposes the PaddleOCR 3.x constructor.

    Signature inspection works for real classes and for injected fakes, so
    recognition dispatch is decided once, at construction time.
    """
    target = (
        engine_or_class
        if inspect.isclass(engine_or_class)
        else type(engine_or_class)
    )
    try:
        parameters = inspect.signature(target.__init__).parameters
    except (TypeError, ValueError):
        return False
    return "use_textline_orientation" in parameters


def _build_engine(lang: str) -> tuple[object, bool]:
    """Construct the PaddleOCR engine and report whether it is the 3.x API."""
    try:
        import numpy  # noqa: F401 - required by the default decoder
        from PIL import Image  # noqa: F401 - required by the default decoder
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError(_MISSING_DEPENDENCIES) from exc

    try:
        if _is_paddle_v3(PaddleOCR):
            return PaddleOCR(lang=lang, use_textline_orientation=True), True
        return PaddleOCR(use_angle_cls=True, lang=lang, show_log=False), False
    except _ENGINE_ERRORS as exc:
        raise RuntimeError(f"OCR engine unavailable: {type(exc).__name__}") from exc


class PaddleOcrBackend:
    """``OcrBackend`` implementation backed by PaddleOCR.

    The engine and the PNG decoder are injectable so tests (and callers with
    an alternate pipeline) do not need the optional dependencies installed.
    The default engine is built lazily on the first ``recognize`` call, so a
    text-layer PDF that needs no OCR never imports PaddleOCR or loads models.
    PaddleOCR 2.x builds are driven through ``ocr(image, cls=True)``; 3.x
    builds through ``predict(image)``; the branch is fixed when the engine is
    created and inspected.
    """

    def __init__(
        self,
        lang: str = "ch",
        engine: object | None = None,
        decoder: Decoder | None = None,
    ) -> None:
        self.lang = lang
        self._engine = engine
        self._use_predict = (
            _is_paddle_v3(engine) if engine is not None else False
        )
        self._decoder = decoder if decoder is not None else _default_decoder

    def _ensure_engine(self) -> object:
        if self._engine is None:
            self._engine, self._use_predict = _build_engine(self.lang)
        return self._engine

    def recognize(self, png: bytes, lang: str) -> list[OcrLine]:
        """Recognize one PNG page.

        The engine language is fixed at construction; the shared protocol
        always passes the same value the CLI configured. Dependency and
        construction errors surface here so the builder can fall back per
        page.
        """
        if lang != self.lang:
            raise ValueError("OCR language cannot change after initialization")
        engine = self._ensure_engine()
        image, width, height = self._decoder(png)
        if self._use_predict:
            raw = engine.predict(image)
        else:
            raw = engine.ocr(image, cls=True)
        return parse_paddle_result(raw, width, height)

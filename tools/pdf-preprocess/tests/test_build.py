import hashlib

import pytest

from bookr_preprocess.build import BuildOptions, build_pack
from bookr_preprocess.extract_text import _join_spans
from bookr_preprocess.model import ExtractedPage, OcrLine, RawLine
from bookr_preprocess.schema import validate_pack


def line(
    text,
    x0=72,
    y0=100,
    x1=500,
    y1=112,
    size=11,
    bold=False,
    confidence=None,
):
    return RawLine(
        text=text,
        x0=x0,
        y0=y0,
        x1=x1,
        y1=y1,
        font_size=size,
        bold=bold,
        confidence=confidence,
    )


def page(number, lines=None, image_rects=None, text_chars=None):
    return ExtractedPage(
        page=number,
        width=612,
        height=792,
        lines=list(lines or []),
        image_rects=list(image_rects or []),
        text_chars=text_chars,
    )


class FakeExtractor:
    def __init__(self, pages):
        self.pages = pages
        self.rendered = []
        self.closed = False

    def page_count(self):
        return len(self.pages)

    def page_size(self, page):
        return (612.0, 792.0)

    def extract_page(self, page):
        return self.pages[page - 1]

    def render_page_png(self, page, dpi):
        self.rendered.append((page, dpi))
        return b'png'

    def outline(self):
        return []

    def close(self):
        self.closed = True


class FakeOcrBackend:
    def __init__(self, lines):
        self.lines = lines
        self.calls = []

    def recognize(self, png, lang):
        self.calls.append((png, lang))
        return list(self.lines)


def test_builds_text_pages_with_fallback_and_toc(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    pages = [
        page(1, [
            line('第一章', y0=80, y1=104, size=22, bold=True),
            line('正文。', y0=130, y1=142),
        ], text_chars=6),
        page(2, text_chars=0),
        page(3, [line('第三页正文。', y0=100, y1=112)],
             image_rects=[(72, 200, 400, 500)], text_chars=6),
    ]
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor(pages),
        options=BuildOptions(ocr='never'),
    )
    pack = result.pack_dict
    assert pack['source']['sha256'] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert pack['generatedAt'].endswith('Z')
    assert len(pack['generatedAt']) == 24
    assert pack['source']['pageCount'] == 3
    assert [b['type'] for b in pack['pages'][0]['blocks']][:2] == ['heading', 'paragraph']
    assert pack['pages'][1]['blocks'][0]['type'] == 'fallback'
    assert any(b['type'] == 'image' for b in pack['pages'][2]['blocks'])
    assert pack['quality']['fallbackPages'] == [2]
    assert pack['toc'][0]['label'] == '第一章'
    assert validate_pack(pack) == []
    assert result.report['source'] == str(source)
    assert result.report['outputPages'] == 3
    assert result.report['textPdf'] is None


def test_auto_ocr_turns_a_scanned_page_into_text(tmp_path):
    source = tmp_path / 'scan.pdf'
    source.write_bytes(b'%PDF-1.4 scan')
    scanned = page(1, image_rects=[(0, 0, 612, 792)], text_chars=0)
    extractor = FakeExtractor([scanned])
    backend = FakeOcrBackend([OcrLine('扫描正文', 0.1, 0.2, 0.9, 0.25, 0.93)])

    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='auto', ocr_lang='ch', dpi=200),
        ocr_backend=backend,
    )
    pack = result.pack_dict
    assert backend.calls == [(b'png', 'ch')]
    assert extractor.rendered == [(1, 200)]
    assert scanned.ocr is True
    assert pack['pages'][0]['blocks'][0]['type'] == 'paragraph'
    assert pack['pages'][0]['blocks'][0]['text'] == '扫描正文'
    assert pack['quality']['ocrPages'] == [1]
    assert pack['quality']['avgConfidence'] == 0.93
    assert pack['quality']['fallbackPages'] == []
    assert result.ocr_lines[1][0].text == '扫描正文'
    assert validate_pack(pack) == []


def test_auto_ocr_skips_pages_with_a_text_layer(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    extractor = FakeExtractor([
        page(1, [line('正文' * 80)], image_rects=[(0, 0, 612, 792)], text_chars=160),
    ])
    backend = FakeOcrBackend([OcrLine('不应出现', 0.1, 0.1, 0.5, 0.2, 0.9)])
    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='auto'),
        ocr_backend=backend,
    )
    assert backend.calls == []
    assert result.pack_dict['quality']['ocrPages'] == []


def test_auto_ocr_without_a_backend_falls_back_with_a_warning(tmp_path):
    source = tmp_path / 'scan.pdf'
    source.write_bytes(b'%PDF-1.4 scan')
    extractor = FakeExtractor([page(1, image_rects=[(72, 72, 540, 720)], text_chars=0)])
    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='auto'),
    )
    pack = result.pack_dict
    assert pack['pages'][0]['blocks'] == [
        {'id': 'p1-b0', 'type': 'fallback', 'rect': {'x': 0.0, 'y': 0.0, 'w': 1.0, 'h': 1.0}}
    ]
    assert pack['quality']['fallbackPages'] == [1]
    assert '第 1 页需要 OCR，但没有可用的 OCR 后端' in result.warnings
    assert validate_pack(pack) == []


def test_ocr_always_without_a_backend_falls_back(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    extractor = FakeExtractor([page(1, [line('正文。')], text_chars=3)])
    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='always'),
    )
    assert result.pack_dict['pages'][0]['blocks'][0]['type'] == 'fallback'
    assert result.pack_dict['quality']['fallbackPages'] == [1]
    assert any('没有可用的 OCR 后端' in warning for warning in result.warnings)


def test_ocr_never_leaves_scanned_pages_as_fallbacks(tmp_path):
    source = tmp_path / 'scan.pdf'
    source.write_bytes(b'%PDF-1.4 scan')
    extractor = FakeExtractor([page(1, image_rects=[(0, 0, 612, 792)], text_chars=0)])
    backend = FakeOcrBackend([OcrLine('不应出现', 0.1, 0.1, 0.5, 0.2, 0.9)])
    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='never'),
        ocr_backend=backend,
    )
    assert backend.calls == []
    # The image still renders, so the page is not a full-page fallback.
    assert result.pack_dict['pages'][0]['blocks'][0]['type'] == 'image'


def test_corrector_rewrites_text_blocks(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')

    class CorrectingCorrector:
        def __init__(self):
            self.seen = []

        def correct(self, text):
            self.seen.append(text)
            return text.replace('正文', '更正正文')

    corrector = CorrectingCorrector()
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, [line('正文。')], text_chars=3)]),
        options=BuildOptions(ocr='never', ai_correct=True),
        corrector=corrector,
    )
    assert corrector.seen == ['正文。']
    assert result.pack_dict['pages'][0]['blocks'][0]['text'] == '更正正文。'
    assert validate_pack(result.pack_dict) == []


def test_raising_corrector_keeps_the_original_text(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')

    class RaisingCorrector:
        def correct(self, text):
            raise ValueError('boom')

    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, [line('正文。')], text_chars=3)]),
        options=BuildOptions(ocr='never', ai_correct=True),
        corrector=RaisingCorrector(),
    )
    assert result.pack_dict['pages'][0]['blocks'][0]['text'] == '正文。'
    assert '第 1 页第 1 块纠错失败（ValueError）' in result.warnings
    assert validate_pack(result.pack_dict) == []


def test_corrector_is_ignored_without_ai_correct(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')

    class CorrectingCorrector:
        def correct(self, text):
            return '更正正文。'

    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, [line('正文。')], text_chars=3)]),
        options=BuildOptions(ocr='never'),
        corrector=CorrectingCorrector(),
    )
    assert result.pack_dict['pages'][0]['blocks'][0]['text'] == '正文。'


def test_failed_page_extraction_becomes_a_fallback(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')

    class PartlyFailingExtractor(FakeExtractor):
        def extract_page(self, page_number):
            if page_number == 2:
                raise RuntimeError('broken page')
            return super().extract_page(page_number)

    extractor = PartlyFailingExtractor([
        page(1, [line('第一页。')], text_chars=4),
        page(2, [line('不会被使用')], text_chars=5),
        page(3, [line('第三页。')], text_chars=4),
    ])
    result = build_pack(
        source_path=str(source),
        extractor=extractor,
        options=BuildOptions(ocr='never'),
    )
    pack = result.pack_dict
    assert pack['source']['pageCount'] == 3
    assert pack['pages'][1]['blocks'][0]['type'] == 'fallback'
    assert pack['quality']['fallbackPages'] == [2]
    assert [block['type'] for block in pack['pages'][0]['blocks']] == ['paragraph']
    assert [block['type'] for block in pack['pages'][2]['blocks']] == ['paragraph']
    assert '第 2 页提取失败（RuntimeError）' in result.warnings
    assert validate_pack(pack) == []


def test_max_pages_builds_only_a_prefix(tmp_path):
    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    pages = [page(number, [line(f'第{number}页。')], text_chars=4) for number in range(1, 4)]
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor(pages),
        options=BuildOptions(ocr='never', max_pages=2),
    )
    pack = result.pack_dict
    assert pack['source']['pageCount'] == 2
    assert len(pack['pages']) == 2
    assert pack['quality']['pages'] == 2
    assert validate_pack(pack) == []


def test_two_space_cells_become_a_table_block_end_to_end(tmp_path):
    source = tmp_path / 'table.pdf'
    source.write_bytes(b'%PDF-1.4 table')
    lines = [
        line('1  2  3', y0=100, y1=112),
        line('4  5  6', y0=114, y1=126),
        line('7  8  9', y0=128, y1=140),
    ]
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, lines, text_chars=27)]),
        options=BuildOptions(ocr='never'),
    )
    assert result.pack_dict['pages'][0]['blocks'][0]['type'] == 'table'
    assert validate_pack(result.pack_dict) == []


def test_span_joining_marks_wide_column_gaps_with_two_spaces():
    def span(text, x0, x1, size=10):
        return {
            'text': text,
            'bbox': (x0, 0, x1, 10),
            'size': size,
            'font': 'Helvetica',
            'flags': 0,
        }

    assert _join_spans([span('a', 0, 10), span('b', 25, 35)]) == 'a  b'
    assert _join_spans([span('a', 0, 10), span('b', 10, 20)]) == 'ab'
    # One point short of the 1.5x threshold stays glued.
    assert _join_spans([span('a', 0, 10), span('b', 24, 34)]) == 'ab'


def test_pymupdf_extractor_reads_text_size_and_outline(tmp_path):
    pymupdf = pytest.importorskip('pymupdf')
    from bookr_preprocess.extract_text import PyMuPdfExtractor

    path = tmp_path / 'book.pdf'
    document = pymupdf.open()
    pdf_page = document.new_page(width=400, height=600)
    pdf_page.insert_text((50, 100), 'Hello world', fontsize=12)
    document.set_toc([[1, 'Chapter one', 1]])
    document.save(path)
    document.close()

    extractor = PyMuPdfExtractor(str(path))
    try:
        assert extractor.page_count() == 1
        assert extractor.page_size(1) == (400.0, 600.0)
        extracted = extractor.extract_page(1)
        assert extracted.text_chars == len('Hello world')
        assert extracted.lines[0].text == 'Hello world'
        assert extracted.lines[0].font_size == pytest.approx(12, abs=0.5)
        assert extractor.outline() == [{'label': 'Chapter one', 'page': 1, 'level': 1}]
        assert extractor.render_page_png(1, 72).startswith(b'\x89PNG')
    finally:
        extractor.close()


def test_image_blocks_respect_text_overlap(tmp_path):
    from bookr_preprocess.model import normalize_rect

    source = tmp_path / 'book.pdf'
    source.write_bytes(b'%PDF-1.4 fake')
    lines = [
        line('正文行', x0=72, x1=500, y0=100 + 14 * index, y1=112 + 14 * index)
        for index in range(20)
    ]
    # The single paragraph covers y 100..378 and x 72..500.
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, lines, text_chars=60, image_rects=[
            (100, 150, 300, 300),   # 100% covered -> skipped
            (100, 360, 300, 560),   #  9% covered -> kept
            (100, 258, 300, 458),   # 60% covered -> skipped
        ])]),
        options=BuildOptions(ocr='never'),
    )
    blocks = result.pack_dict['pages'][0]['blocks']
    assert [block['type'] for block in blocks] == ['paragraph', 'image']
    assert blocks[1]['rect'] == normalize_rect(100, 360, 300, 560, 612, 792)


def test_auto_ocr_uses_extracted_chars_when_none_and_ocrs_empty_pages(tmp_path):
    source = tmp_path / 'scan.pdf'
    source.write_bytes(b'%PDF-1.4 scan')
    ocr_line = OcrLine('扫描正文', 0.1, 0.2, 0.9, 0.25, 0.93)

    backend = FakeOcrBackend([ocr_line])
    text_page = page(
        1,
        [line('字' * 150)],
        image_rects=[(0, 0, 612, 792)],
        text_chars=None,
    )
    build_pack(
        source_path=str(source),
        extractor=FakeExtractor([text_page]),
        options=BuildOptions(ocr='auto'),
        ocr_backend=backend,
    )
    assert backend.calls == []

    backend = FakeOcrBackend([ocr_line])
    empty_page = page(1, image_rects=[(0, 0, 612, 792)], text_chars=None)
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([empty_page]),
        options=BuildOptions(ocr='auto'),
        ocr_backend=backend,
    )
    assert backend.calls == [(b'png', 'ch')]
    assert result.pack_dict['quality']['ocrPages'] == [1]


def test_text_layer_insertion_failures_are_reported(tmp_path, monkeypatch):
    from bookr_preprocess import build as build_module

    source = tmp_path / 'scan.pdf'
    source.write_bytes(b'%PDF-1.4 scan')
    lines = [
        OcrLine('第一行', 0.1, 0.10, 0.5, 0.15, 0.9),
        OcrLine('第二行', 0.1, 0.20, 0.5, 0.25, 0.9),
    ]
    calls = []

    def fake_writer(source_path, output_path, ocr_lines):
        calls.append(output_path)
        return 1

    monkeypatch.setattr(build_module, 'write_text_layer_pdf', fake_writer)
    result = build_pack(
        source_path=str(source),
        extractor=FakeExtractor([page(1, image_rects=[(0, 0, 612, 792)], text_chars=0)]),
        options=BuildOptions(ocr='auto', text_pdf=str(tmp_path / 'out.pdf')),
        ocr_backend=FakeOcrBackend(lines),
    )
    assert calls == [str(tmp_path / 'out.pdf')]
    assert '文字层插入失败 1 行' in result.warnings
    assert '文字层插入失败 1 行' in result.pack_dict['quality']['warnings']


def test_rotated_pages_use_the_displayed_coordinate_space(tmp_path):
    pymupdf = pytest.importorskip('pymupdf')
    from bookr_preprocess.extract_text import PyMuPdfExtractor
    from bookr_preprocess.model import normalize_rect

    path = tmp_path / 'rotated.pdf'
    document = pymupdf.open()
    pdf_page = document.new_page(width=400, height=600)
    pdf_page.insert_text((50, 100), 'Rotated', fontsize=12)
    pdf_page.set_rotation(90)
    document.save(path)
    document.close()

    extractor = PyMuPdfExtractor(str(path))
    try:
        assert extractor.page_size(1) == (600.0, 400.0)
        extracted = extractor.extract_page(1)
    finally:
        extractor.close()

    raw = extracted.lines[0]
    rect = normalize_rect(
        raw.x0, raw.y0, raw.x1, raw.y1, extracted.width, extracted.height
    )
    assert rect['x'] + rect['w'] <= 1
    assert rect['y'] + rect['h'] <= 1
    # A 90° rotation moves the text from the left edge to the right half.
    assert rect['x'] > 0.5
    assert rect['y'] < 0.5

    result = build_pack(
        source_path=str(path),
        extractor=PyMuPdfExtractor(str(path)),
        options=BuildOptions(ocr='never'),
    )
    block = result.pack_dict['pages'][0]['blocks'][0]
    assert block['type'] == 'paragraph'
    assert block['rect']['x'] > 0.5

import pytest

from bookr_preprocess.model import RawLine
from bookr_preprocess.pdf_writer import write_text_layer_pdf

pymupdf = pytest.importorskip('pymupdf')


def blank_pdf(path, pages=1):
    document = pymupdf.open()
    for _ in range(pages):
        document.new_page(width=612, height=792)
    document.save(path)
    document.close()
    return path


def test_text_layer_pdf_round_trips(tmp_path):
    source = blank_pdf(tmp_path / 'blank.pdf')
    lines = {1: [RawLine('OCR line', 72, 100, 300, 112, 11, confidence=0.9)]}
    count = write_text_layer_pdf(str(source), str(tmp_path / 'searchable.pdf'), lines)
    assert count == 1
    text = pymupdf.open(tmp_path / 'searchable.pdf')[0].get_text()
    assert 'OCR line' in text


def test_text_layer_pdf_uses_a_cjk_font_for_chinese(tmp_path):
    source = blank_pdf(tmp_path / 'blank.pdf')
    lines = {1: [RawLine('扫描正文', 72, 100, 200, 112, 11, confidence=0.9)]}
    count = write_text_layer_pdf(str(source), str(tmp_path / 'searchable.pdf'), lines)
    assert count == 1
    text = pymupdf.open(tmp_path / 'searchable.pdf')[0].get_text()
    assert '扫描正文' in text


def test_text_layer_pdf_skips_blank_and_out_of_range_lines(tmp_path):
    source = blank_pdf(tmp_path / 'blank.pdf')
    lines = {
        1: [
            RawLine('   ', 72, 100, 120, 112, 11),
            RawLine('kept', 72, 120, 200, 132, 11),
        ],
        5: [RawLine('page five', 72, 100, 200, 112, 11)],
    }
    count = write_text_layer_pdf(str(source), str(tmp_path / 'searchable.pdf'), lines)
    assert count == 1
    text = pymupdf.open(tmp_path / 'searchable.pdf')[0].get_text()
    assert 'kept' in text
    assert 'page five' not in text


def test_text_layer_pdf_without_lines_is_still_written(tmp_path):
    source = blank_pdf(tmp_path / 'blank.pdf', pages=2)
    count = write_text_layer_pdf(str(source), str(tmp_path / 'out.pdf'), {})
    assert count == 0
    assert pymupdf.open(tmp_path / 'out.pdf').page_count == 2


@pytest.mark.parametrize(
    'rotation, line_box',
    [
        (90, (420, 100, 520, 112)),
        (180, (60, 500, 160, 512)),
        (270, (100, 100, 200, 112)),
    ],
)
@pytest.mark.parametrize('text', ['on edge', '扫描正文'])
def test_text_layer_insertion_follows_page_rotation(tmp_path, rotation, line_box, text):
    source = tmp_path / 'rotated.pdf'
    document = pymupdf.open()
    page = document.new_page(width=400, height=600)
    page.set_rotation(rotation)
    document.save(source)
    document.close()

    # Coordinates are in displayed space, as produced by OCR on the render.
    x0, y0, x1, y1 = line_box
    lines = {1: [RawLine(text, x0, y0, x1, y1, 11, confidence=0.9)]}
    output = tmp_path / 'searchable.pdf'
    assert write_text_layer_pdf(str(source), str(output), lines) == 1

    rotated = pymupdf.open(output)[0]
    extracted = [
        pymupdf.Rect(line['bbox']) * rotated.rotation_matrix
        for block in rotated.get_text('dict')['blocks']
        for line in block.get('lines', [])
    ]
    assert len(extracted) == 1
    displayed = extracted[0]
    assert text in rotated.get_text()
    # The glyph run must be horizontal in displayed space, not mirrored onto
    # the unrotated axis; compare both ends, not just the anchor.
    assert displayed.width > displayed.height
    assert displayed.x0 == pytest.approx(x0, abs=1)
    assert displayed.x1 > displayed.x0 + 10
    assert displayed.y0 == pytest.approx(y0, abs=3)
    assert displayed.y1 == pytest.approx(y1, abs=3)

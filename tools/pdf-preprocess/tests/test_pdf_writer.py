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

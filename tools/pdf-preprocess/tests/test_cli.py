import json

import pytest

from bookr_preprocess.model import OcrLine
from bookr_preprocess.schema import validate_pack

from bookr_preprocess.cli import main

pymupdf = pytest.importorskip('pymupdf')


def make_text_pdf(path, texts, width=612, height=792):
    document = pymupdf.open()
    for text in texts:
        page = document.new_page(width=width, height=height)
        page.insert_text((72, 100), text, fontsize=12)
    document.save(path)
    document.close()
    return path


def make_blank_pdf(path, pages=1):
    document = pymupdf.open()
    for _ in range(pages):
        document.new_page(width=612, height=792)
    document.save(path)
    document.close()
    return path


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def test_cli_writes_pack_and_report(tmp_path):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text', 'Page two text'])
    out = tmp_path / 'book.bookr.json'
    report = tmp_path / 'book.report.json'
    assert main([
        str(pdf), '--out', str(out), '--report', str(report),
        '--ocr', 'never', '--force',
    ]) == 0
    pack = read_json(out)
    assert pack['source']['pageCount'] == 2
    assert pack['generatedAt'].endswith('Z')
    assert validate_pack(pack) == []
    assert report.exists()
    report_data = read_json(report)
    assert set(report_data) == {'quality', 'source', 'generatedAt'}
    assert report_data['source'] == str(pdf)
    assert report_data['generatedAt'] == pack['generatedAt']
    assert report_data['quality'] == pack['quality']


def test_cli_refuses_to_overwrite_without_force(tmp_path):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    out = tmp_path / 'book.bookr.json'
    out.write_text('{"existing": true}', encoding='utf-8')
    assert main([str(pdf), '--out', str(out), '--ocr', 'never']) == 2
    assert read_json(out) == {'existing': True}
    assert main([str(pdf), '--out', str(out), '--ocr', 'never', '--force']) == 0
    assert 'schemaVersion' in read_json(out)


def test_cli_errors_when_input_is_missing(tmp_path, capsys):
    assert main([]) == 2
    assert 'PDF' in capsys.readouterr().err
    assert main([str(tmp_path / 'missing.pdf'), '--out', str(tmp_path / 'o.json')]) == 2
    assert '不存在' in capsys.readouterr().err


def test_cli_requires_out(tmp_path):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    assert main([str(pdf)]) == 2


def test_cli_ai_correct_requires_api_key(tmp_path, monkeypatch, capsys):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    monkeypatch.delenv('DEEPSEEK_API_KEY', raising=False)
    assert main([
        str(pdf), '--out', str(tmp_path / 'o.json'), '--ai-correct',
    ]) == 2
    assert 'DEEPSEEK_API_KEY' in capsys.readouterr().err
    assert not (tmp_path / 'o.json').exists()


def test_cli_ocr_always_without_backend_returns_3(tmp_path, monkeypatch, capsys):
    from bookr_preprocess import cli

    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    monkeypatch.setattr(cli, '_load_ocr_backend', lambda lang: None)
    assert main([
        str(pdf), '--out', str(tmp_path / 'o.json'), '--ocr', 'always',
    ]) == 3
    assert "pip install -e '.[ocr]'" in capsys.readouterr().err
    assert not (tmp_path / 'o.json').exists()


def test_cli_ocr_auto_without_backend_still_builds(tmp_path, monkeypatch):
    from bookr_preprocess import cli

    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    monkeypatch.setattr(cli, '_load_ocr_backend', lambda lang: None)
    out = tmp_path / 'o.json'
    # A text page needs no OCR, so a missing backend is only a warning.
    assert main([str(pdf), '--out', str(out), '--ocr', 'auto']) == 0
    assert validate_pack(read_json(out)) == []


def test_cli_writes_a_text_layer_pdf_with_ocr(tmp_path, monkeypatch):
    from bookr_preprocess import cli

    pdf = make_blank_pdf(tmp_path / 'blank.pdf')
    out = tmp_path / 'book.bookr.json'
    text_pdf = tmp_path / 'searchable.pdf'

    class Backend:
        def recognize(self, png, lang):
            return [OcrLine('扫描正文', 0.1, 0.2, 0.5, 0.25, 0.9)]

    monkeypatch.setattr(cli, '_load_ocr_backend', lambda lang: Backend())
    assert main([
        str(pdf), '--out', str(out), '--text-pdf', str(text_pdf),
        '--ocr', 'always', '--force',
    ]) == 0
    pack = read_json(out)
    assert pack['quality']['ocrPages'] == [1]
    assert pack['pages'][0]['blocks'][0]['text'] == '扫描正文'
    assert text_pdf.exists()
    assert '扫描正文' in pymupdf.open(text_pdf)[0].get_text()


def test_cli_max_pages_and_verbose(tmp_path, capsys):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one', 'Page two', 'Page three'])
    out = tmp_path / 'o.json'
    assert main([
        str(pdf), '--out', str(out), '--ocr', 'never',
        '--max-pages', '2', '--verbose', '--force',
    ]) == 0
    assert read_json(out)['source']['pageCount'] == 2
    captured = capsys.readouterr()
    assert '页数：2' in captured.out
    assert '警告：' in captured.err
    assert '建议启用 OCR' in captured.err


def test_cli_rejects_output_equal_to_input(tmp_path, capsys):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    original = pdf.read_bytes()
    assert main([
        str(pdf), '--out', str(pdf), '--force', '--ocr', 'never',
    ]) == 2
    assert '不能使用同一路径' in capsys.readouterr().err
    assert pdf.read_bytes() == original


def test_cli_rejects_report_equal_to_output(tmp_path, capsys):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    out = tmp_path / 'book.bookr.json'
    assert main([
        str(pdf), '--out', str(out), '--report', str(out), '--ocr', 'never',
    ]) == 2
    assert '不能使用同一路径' in capsys.readouterr().err
    assert not out.exists()


def test_cli_rejects_text_pdf_equal_to_input(tmp_path, capsys):
    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])
    original = pdf.read_bytes()
    out = tmp_path / 'book.bookr.json'
    assert main([
        str(pdf), '--out', str(out), '--text-pdf', str(pdf), '--ocr', 'never',
    ]) == 2
    assert '不能使用同一路径' in capsys.readouterr().err
    assert pdf.read_bytes() == original
    assert not out.exists()


def test_cli_configures_stream_encoding(tmp_path, monkeypatch):
    import sys

    from bookr_preprocess import cli

    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])

    class RecordingStream:
        def __init__(self):
            self.calls = []

        def reconfigure(self, **kwargs):
            self.calls.append(kwargs)

        def write(self, text):
            return len(text)

        def flush(self):
            pass

    stdout = RecordingStream()
    stderr = RecordingStream()
    monkeypatch.setattr(sys, 'stdout', stdout)
    monkeypatch.setattr(sys, 'stderr', stderr)
    monkeypatch.setattr(cli, '_load_ocr_backend', lambda lang: None)

    out = tmp_path / 'book.bookr.json'
    assert main([str(pdf), '--out', str(out), '--ocr', 'never']) == 0
    expected = [{'encoding': 'utf-8', 'errors': 'replace'}]
    assert stdout.calls == expected
    assert stderr.calls == expected
    assert out.exists()


def test_cli_invalid_pdf_returns_2(tmp_path, capsys):
    broken = tmp_path / 'broken.pdf'
    broken.write_text('not a pdf', encoding='utf-8')
    assert main([
        str(broken), '--out', str(tmp_path / 'o.json'), '--ocr', 'never',
    ]) == 2
    err = capsys.readouterr().err
    assert '无法打开 PDF：FileDataError' in err
    assert 'Traceback' not in err
    assert not (tmp_path / 'o.json').exists()


def test_cli_missing_pymupdf_returns_3(tmp_path, monkeypatch, capsys):
    from bookr_preprocess import extract_text

    pdf = make_text_pdf(tmp_path / 'in.pdf', ['Page one text'])

    def missing():
        raise RuntimeError('PyMuPDF is required: pip install pymupdf')

    monkeypatch.setattr(extract_text, '_pymupdf', missing)
    out = tmp_path / 'o.json'
    assert main([str(pdf), '--out', str(out), '--ocr', 'never']) == 3
    assert 'PyMuPDF is required' in capsys.readouterr().err
    assert not out.exists()


def test_cli_text_layer_write_error_returns_2(tmp_path, monkeypatch, capsys):
    from bookr_preprocess import build, cli

    pdf = make_blank_pdf(tmp_path / 'blank.pdf')

    class Backend:
        def recognize(self, png, lang):
            return [OcrLine('扫描正文', 0.1, 0.2, 0.5, 0.25, 0.9)]

    def failing_writer(source_path, output_path, ocr_lines):
        raise ValueError('cannot save onto the source')

    monkeypatch.setattr(cli, '_load_ocr_backend', lambda lang: Backend())
    monkeypatch.setattr(build, 'write_text_layer_pdf', failing_writer)
    assert main([
        str(pdf), '--out', str(tmp_path / 'o.json'),
        '--text-pdf', str(tmp_path / 'searchable.pdf'), '--ocr', 'always',
    ]) == 2
    assert '生成重排包失败' in capsys.readouterr().err
    assert not (tmp_path / 'o.json').exists()

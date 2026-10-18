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

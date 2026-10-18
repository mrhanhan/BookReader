import builtins

import pytest

from bookr_preprocess.ocr import PaddleOcrBackend, parse_paddle_result


def test_parses_paddle_v2_result_and_normalizes_boxes():
    raw = [[
        [[[10, 20], [110, 20], [110, 40], [10, 40]], ('第一行', 0.93)],
        [[[10, 50], [210, 50], [210, 70], [10, 70]], ('second line', 0.81)],
    ]]
    lines = parse_paddle_result(raw, width=200, height=100)
    assert lines[0].text == '第一行'
    assert lines[0].x0 == 0.05 and lines[0].y0 == 0.2
    assert lines[0].x1 == 0.55 and lines[0].y1 == 0.4
    assert lines[0].confidence == 0.93
    assert lines[1].text == 'second line'
    assert lines[1].x1 == 1.0


def test_parses_newer_dict_result_and_skips_empty_text():
    raw = [{'rec_texts': ['A', '', 'B'], 'rec_scores': [0.9, 0.8, 0.7],
            'rec_polys': [[[0, 0], [50, 0], [50, 10], [0, 10]],
                          [[0, 10], [50, 10], [50, 20], [0, 20]],
                          [[0, 20], [50, 20], [50, 30], [0, 30]]]}]
    lines = parse_paddle_result(raw, width=100, height=100)
    assert [line.text for line in lines] == ['A', 'B']
    assert [line.confidence for line in lines] == [0.9, 0.7]


def test_parses_dict_result_with_dt_polys_fallback():
    raw = [{
        'rec_texts': ['甲', '乙'],
        'rec_scores': [0.6],
        'dt_polys': [
            [[0, 0], [10, 0], [10, 10], [0, 10]],
            [[0, 10], [10, 10], [10, 20], [0, 20]],
        ],
    }]
    lines = parse_paddle_result(raw, width=10, height=20)
    assert [line.text for line in lines] == ['甲', '乙']
    assert lines[1].confidence == 0.0


def test_boxes_are_clamped_into_unit_square_and_sorted():
    raw = [[
        [[[50, 50], [90, 50], [90, 60], [50, 60]], ('bottom', 0.9)],
        [[[10, 10], [90, 10], [90, 20], [10, 20]], ('top', 0.9)],
        [[[-20, 50], [40, 50], [40, 60], [-20, 60]], ('bottom-left', 0.9)],
        [[[80, 90], [140, 90], [140, 130], [80, 130]], ('edge', 0.9)],
    ]]
    lines = parse_paddle_result(raw, width=100, height=100)
    assert [line.text for line in lines] == ['top', 'bottom-left', 'bottom', 'edge']
    assert lines[1].x0 == 0.0
    assert lines[3].x1 == 1.0 and lines[3].y1 == 1.0


def test_skips_blank_and_malformed_entries():
    raw = [[
        [[[0, 0], [10, 0], [10, 10], [0, 10]], ('   ', 0.9)],
        [[[0, 0], [10, 0], [10, 10], [0, 10]]],
        'not-an-entry',
        [[[0, 10], [10, 10], [10, 20], [0, 20]], ('kept', 0.5)],
    ]]
    lines = parse_paddle_result(raw, width=10, height=20)
    assert [line.text for line in lines] == ['kept']


def test_confidence_defaults_to_zero_when_missing():
    raw = [[[[[0, 0], [10, 0], [10, 10], [0, 10]], '无分数']]]
    lines = parse_paddle_result(raw, width=10, height=10)
    assert lines[0].confidence == 0.0


def test_unrecognized_result_shapes_are_ignored():
    assert parse_paddle_result(None, width=10, height=10) == []
    assert parse_paddle_result([], width=10, height=10) == []
    assert parse_paddle_result([{'unexpected': True}], width=10, height=10) == []


def test_backend_uses_injected_engine_and_decoder():
    class Engine:
        def __init__(self):
            self.calls = []

        def ocr(self, image, cls=True):
            self.calls.append((image, cls))
            return [[[[[0, 0], [10, 0], [10, 10], [0, 10]], ('ok', 0.9)]]]

    engine = Engine()
    image = object()
    backend = PaddleOcrBackend(engine=engine, decoder=lambda png: (image, 100, 100))
    lines = backend.recognize(b'png', 'ch')
    assert lines[0].text == 'ok'
    assert engine.calls == [(image, True)]


def test_backend_reports_missing_dependencies(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith('paddleocr'):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, '__import__', fake_import)
    with pytest.raises(RuntimeError, match='OCR dependencies missing'):
        PaddleOcrBackend('ch')

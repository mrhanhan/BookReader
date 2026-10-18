import json
from pathlib import Path

from bookr_preprocess import schema
from bookr_preprocess.schema import PackValidationError, validate_pack

GOLDEN = (
    Path(__file__).parents[3]
    / 'packages/shared/src/__tests__/fixtures/golden.bookr.json'
)


def golden_pack():
    return json.loads(GOLDEN.read_text(encoding='utf-8'))


def test_golden_pack_is_valid():
    pack = json.loads(GOLDEN.read_text(encoding='utf-8'))
    assert validate_pack(pack) == []


def test_rejects_wrong_schema_version():
    pack = golden_pack()
    pack['schemaVersion'] = 2
    assert validate_pack(pack)


def test_rejects_page_count_mismatch():
    pack = golden_pack()
    pack['source']['pageCount'] = 3
    assert 'pages.length must equal source.pageCount' in validate_pack(pack)


def test_rejects_pages_out_of_order():
    pack = golden_pack()
    pack['pages'][1]['page'] = 3
    assert 'pages must be numbered 1..n in order' in validate_pack(pack)


def test_rejects_duplicate_block_ids_on_a_page():
    pack = golden_pack()
    pack['pages'][0]['blocks'][1]['id'] = 'p1-b0'
    assert 'duplicate block id p1-b0 on page 1' in validate_pack(pack)


def test_rejects_paragraph_without_text():
    pack = golden_pack()
    del pack['pages'][0]['blocks'][1]['text']
    errors = validate_pack(pack)
    assert any('paragraph blocks require text' in error for error in errors)


def test_rejects_heading_without_level():
    pack = golden_pack()
    del pack['pages'][0]['blocks'][0]['level']
    errors = validate_pack(pack)
    assert any('heading blocks require a level' in error for error in errors)


def test_rejects_rect_outside_the_unit_square():
    pack = golden_pack()
    pack['pages'][0]['blocks'][0]['rect']['x'] = 1.1
    errors = validate_pack(pack)
    assert any('rect out of bounds' in error for error in errors)


def test_rejects_rect_that_overflows_the_page():
    pack = golden_pack()
    pack['pages'][0]['blocks'][0]['rect'] = {
        'x': 0.5,
        'y': 0.1,
        'w': 0.6,
        'h': 0.05,
    }
    errors = validate_pack(pack)
    assert any('x + w' in error for error in errors)


def test_rejects_unsupported_block_type():
    pack = golden_pack()
    pack['pages'][0]['blocks'][0]['type'] = 'sidebar'
    errors = validate_pack(pack)
    assert any('unsupported block type' in error for error in errors)


def test_rejects_block_count_over_the_page_limit():
    pack = golden_pack()
    pack['pages'][0]['blocks'] = [
        {'id': f'p1-b{index}', 'type': 'image', 'rect': {'x': 0.0, 'y': 0.0, 'w': 1.0, 'h': 1.0}}
        for index in range(schema.MAX_REFLOW_BLOCKS_PER_PAGE + 1)
    ]
    errors = validate_pack(pack)
    assert any('at most 2000 blocks' in error for error in errors)


def test_rejects_block_count_over_the_pack_limit(monkeypatch):
    pack = golden_pack()
    monkeypatch.setattr(schema, 'MAX_REFLOW_BLOCKS', 2)
    errors = validate_pack(pack)
    assert any('at most 2 blocks' in error for error in errors)


def test_rejects_text_longer_than_the_utf16_limit():
    pack = golden_pack()
    pack['pages'][0]['blocks'][1]['text'] = '𠮷' * 10001  # 20002 UTF-16 units
    errors = validate_pack(pack)
    assert any('20000' in error for error in errors)


def test_rejects_non_utc_generated_at():
    pack = golden_pack()
    pack['generatedAt'] = '2026-10-18T08:00:00.000+00:00'
    assert validate_pack(pack)


def test_accumulates_every_violation():
    pack = golden_pack()
    pack['schemaVersion'] = 2
    del pack['pages'][0]['blocks'][1]['text']
    assert len(validate_pack(pack)) >= 2


def test_malformed_packs_return_errors_instead_of_raising():
    assert validate_pack({})
    assert validate_pack({
        'schemaVersion': 1,
        'source': 'not-an-object',
        'generatedAt': 1,
        'tool': None,
        'quality': [],
        'toc': {},
        'pages': 'not-an-array',
    })


def test_pack_validation_error_carries_errors():
    error = PackValidationError(['first', 'second'])
    assert error.errors == ['first', 'second']
    assert 'first' in str(error)

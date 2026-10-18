from bookr_preprocess.detect import has_usable_text_layer
from bookr_preprocess.layout import (
    body_font_size,
    filtered_lines,
    lines_to_blocks,
    merge_lines,
    repeated_margin_texts,
    source_text,
)
from bookr_preprocess.model import (
    TOOL_NAME,
    Block,
    ExtractedPage,
    RawLine,
    ReflowPack,
    normalize_rect,
    utf16_len,
)
from bookr_preprocess.quality import build_quality


def line(text, x0=72, y0=100, x1=500, y1=112, size=11, bold=False, confidence=None):
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


def test_utf16_len_counts_supplementary_characters():
    assert utf16_len('a𠮷b') == 4
    assert utf16_len('第一章') == 3


def test_merge_lines_handles_cjk_and_hyphenation():
    assert merge_lines(['这是第一行', '接着第二行']) == '这是第一行接着第二行'
    assert merge_lines(['inter-', 'national']) == 'international'
    assert merge_lines(['hello', 'world']) == 'hello world'


def test_merge_lines_joins_supplementary_cjk():
    assert merge_lines(['前𠮷', '后文']) == '前𠮷后文'


def test_heading_detection_and_levels():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一章', y0=80, y1=104, size=22, bold=True),
        line('第一段正文内容。', y0=130, y1=142, size=11),
        line('第二段正文内容。', y0=160, y1=172, size=11),
    ])
    blocks = lines_to_blocks(page, set())
    assert blocks[0].type == 'heading'
    assert blocks[0].level == 1
    assert [b.type for b in blocks[1:]] == ['paragraph', 'paragraph']


def test_paragraph_breaks_on_indent_and_gap():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一段第一行', x0=72, y0=100),
        line('第一段第二行', x0=72, y0=114),
        line('第二段首行', x0=90, y0=128),
    ])
    texts = [b.text for b in lines_to_blocks(page, set())]
    assert texts == ['第一段第一行第一段第二行', '第二段首行']


def test_margin_noise_and_page_numbers_are_dropped():
    pages = [
        ExtractedPage(page=i, width=612, height=792, lines=[
            line('Bookr Header', y0=10, y1=20, size=8),
            line('正文内容', y0=100, y1=112),
            line(str(i), y0=770, y1=780, size=8),
        ])
        for i in range(1, 6)
    ]
    repeated = repeated_margin_texts(pages)
    blocks = lines_to_blocks(pages[0], repeated)
    assert [b.text for b in blocks] == ['正文内容']


def test_character_offsets_include_newlines_and_utf16():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('a𠮷b', y0=100, y1=112),
        line('第二行', y0=120, y1=132),
    ])
    block = lines_to_blocks(page, set())[0]
    assert block.source_char_start == 0
    assert block.source_char_end == utf16_len('a𠮷b\n第二行')


def test_rect_normalization_clamps():
    assert normalize_rect(-10, 10, 700, 900, 612, 792) == {
        'x': 0.0,
        'y': 0.012626,
        'w': 1.0,
        'h': 0.987374,
    }


def test_vertical_gap_splits_and_small_gap_merges():
    split_page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一行', y0=100, y1=112),
        line('第二行', y0=140, y1=152),
    ])
    assert len(lines_to_blocks(split_page, set())) == 2

    merged_page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一行', y0=100, y1=112),
        line('第二行', y0=120, y1=132),
    ])
    assert [b.text for b in lines_to_blocks(merged_page, set())] == ['第一行第二行']


def test_sentence_end_does_not_split_a_normal_wrap():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一句话。', y0=100, y1=112),
        line('第二句话', y0=116, y1=128),
    ])
    blocks = lines_to_blocks(page, set())
    assert len(blocks) == 1
    assert blocks[0].text == '第一句话。第二句话'


def test_body_left_margin_ignores_formula_at_page_edge():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('a = b ^ c', x0=0, y0=100, y1=112, size=14),
        line('第一段正文', x0=72, y0=126, y1=138),
        line('第二行正文', x0=72, y0=140, y1=152),
        line('第三行正文', x0=72, y0=154, y1=166),
    ])
    blocks = lines_to_blocks(page, set())
    assert [b.type for b in blocks] == ['formula', 'paragraph']
    assert blocks[1].text == '第一段正文第二行正文第三行正文'


def test_table_detection_needs_wide_cell_gaps():
    table_page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('1  2  3', y0=100, y1=112),
        line('4  5  6', y0=114, y1=126),
        line('7  8  9', y0=128, y1=140),
    ])
    assert [b.type for b in lines_to_blocks(table_page, set())] == ['table']

    prose_page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('1 2 3', y0=100, y1=112),
        line('4 5 6', y0=114, y1=126),
        line('7 8 9', y0=128, y1=140),
    ])
    assert [b.type for b in lines_to_blocks(prose_page, set())] == ['paragraph']


def test_single_page_margin_text_is_not_treated_as_noise():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('Bookr Header', y0=10, y1=20, size=8),
        line('正文内容', y0=100, y1=112),
    ])
    assert repeated_margin_texts([page]) == set()
    assert [b.text for b in lines_to_blocks(page, set())] == [
        'Bookr Header',
        '正文内容',
    ]


def test_block_offsets_index_into_source_text():
    page = ExtractedPage(page=1, width=612, height=792, lines=[
        line('第一行', y0=100, y1=112),
        line('第二行', y0=114, y1=126),
        line('第三段', y0=160, y1=172),
    ])
    assert [line.text for line in filtered_lines(page, set())] == [
        '第一行',
        '第二行',
        '第三段',
    ]
    source = source_text(page, set())
    assert source == '第一行\n第二行\n第三段'
    blocks = lines_to_blocks(page, set())
    assert [source[b.source_char_start:b.source_char_end] for b in blocks] == [
        '第一行\n第二行',
        '第三段',
    ]


def test_body_font_size_is_character_weighted():
    lines = [line('标题', size=22), line('正文' * 10, size=11)]
    assert body_font_size(lines) == 11


def test_text_blocks_carry_source_offsets_only():
    page = ExtractedPage(page=2, width=612, height=792, lines=[
        line('a = b ^ c', x0=0, y0=100, x1=600, y1=112),
        line('第一段', y0=200, y1=212),
    ])
    blocks = lines_to_blocks(page, set())
    assert blocks[0].type == 'formula'
    assert blocks[0].source_char_start is None
    assert blocks[0].source_char_end is None
    assert blocks[1].type == 'paragraph'
    assert blocks[1].source_char_start == utf16_len('a = b ^ c\n')
    assert blocks[1].source_char_end == utf16_len('a = b ^ c\n第一段')


def test_build_quality_summarizes_counts_and_confidences():
    pages = [
        ExtractedPage(page=1, width=612, height=792, lines=[
            line('正文', confidence=0.8),
        ])
    ]
    blocks = {
        1: [
            Block(
                id='p1-b0',
                type='heading',
                rect={'x': 0.1, 'y': 0.1, 'w': 0.5, 'h': 0.05},
                text='标题',
                level=1,
                confidence=0.9,
            ),
            Block(
                id='p1-b1',
                type='paragraph',
                rect={'x': 0.1, 'y': 0.2, 'w': 0.5, 'h': 0.05},
                text='正文',
            ),
            Block(
                id='p1-b2',
                type='image',
                rect={'x': 0.1, 'y': 0.3, 'w': 0.5, 'h': 0.05},
            ),
        ]
    }
    warnings = [f'w{i}' for i in range(120)]
    quality = build_quality(pages, blocks, [3, 1, 3], [2, 2], warnings)
    assert quality == {
        'pages': 1,
        'textBlocks': 2,
        'fallbackPages': [1, 3],
        'ocrPages': [2],
        'avgConfidence': 0.8,
        'warnings': warnings[:100],
    }


def test_build_quality_has_no_average_without_confidences():
    pages = [ExtractedPage(page=1, width=612, height=792, lines=[line('正文')])]
    blocks = {
        1: [
            Block(
                id='p1-b0',
                type='paragraph',
                rect={'x': 0.1, 'y': 0.2, 'w': 0.5, 'h': 0.05},
                text='正文',
            )
        ]
    }
    assert build_quality(pages, blocks, [], [], [])['avgConfidence'] is None


def test_has_usable_text_layer_needs_at_least_half_the_pages():
    def page(number, chars):
        extracted = ExtractedPage(page=number, width=612, height=792, lines=[])
        extracted.text_chars = chars
        return extracted

    assert has_usable_text_layer([page(1, 200), page(2, 120), page(3, 0)])
    assert not has_usable_text_layer([page(1, 120), page(2, 0), page(3, 0)])
    assert not has_usable_text_layer([])


def test_has_usable_text_layer_falls_back_to_line_lengths_when_unset():
    page = ExtractedPage(page=1, width=612, height=792, lines=[line('字' * 120)])
    assert page.text_chars is None
    assert has_usable_text_layer([page])


def test_has_usable_text_layer_treats_explicit_zero_as_empty():
    page = ExtractedPage(
        page=1,
        width=612,
        height=792,
        lines=[line('字' * 120)],
        text_chars=0,
    )
    assert not has_usable_text_layer([page])


def test_block_to_dict_uses_camel_case_and_omits_confidence():
    block = Block(
        id='p1-b0',
        type='heading',
        rect={'x': 0.0, 'y': 0.0, 'w': 1.0, 'h': 1.0},
        text='第一章',
        level=1,
        source_char_start=0,
        source_char_end=3,
        confidence=0.9,
    )
    data = block.to_dict()
    assert data == {
        'id': 'p1-b0',
        'type': 'heading',
        'rect': {'x': 0.0, 'y': 0.0, 'w': 1.0, 'h': 1.0},
        'text': '第一章',
        'level': 1,
        'sourceCharStart': 0,
        'sourceCharEnd': 3,
    }
    assert 'confidence' not in data


def test_reflow_pack_to_dict_uses_contract_keys():
    pack = ReflowPack(
        schema_version=1,
        source_sha256='a' * 64,
        page_count=2,
        generated_at='2026-10-18T08:00:00.000Z',
        tool_version='0.1.0',
        pages=[],
        toc=[],
        quality={},
    )
    data = pack.to_dict()
    assert set(data) == {
        'schemaVersion',
        'source',
        'generatedAt',
        'tool',
        'quality',
        'toc',
        'pages',
    }
    assert data['schemaVersion'] == 1
    assert data['source'] == {'sha256': 'a' * 64, 'pageCount': 2}
    assert data['tool'] == {'name': TOOL_NAME, 'version': '0.1.0'}

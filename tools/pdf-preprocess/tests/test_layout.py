from bookr_preprocess.detect import has_usable_text_layer
from bookr_preprocess.layout import (
    body_font_size,
    lines_to_blocks,
    merge_lines,
    repeated_margin_texts,
)
from bookr_preprocess.model import Block, ExtractedPage, RawLine, normalize_rect, utf16_len
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


def test_has_usable_text_layer_falls_back_to_line_lengths():
    page = ExtractedPage(page=1, width=612, height=792, lines=[line('字' * 120)])
    assert has_usable_text_layer([page])

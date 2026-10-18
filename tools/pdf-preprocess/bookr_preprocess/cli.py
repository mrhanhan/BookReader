"""Command line entry point for the local PDF preprocessing tool."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Sequence

from .build import BuildOptions, build_pack
from .extract_text import PyMuPdfExtractor
from .schema import PackValidationError

OCR_DEPENDENCY_MESSAGE = "OCR 需要安装可选依赖：pip install -e '.[ocr]'"
AI_KEY_MESSAGE = "AI 纠错需要设置 DEEPSEEK_API_KEY"


def _load_ocr_backend(lang: str):
    """Load PaddleOCR lazily; ``None`` means OCR is unavailable."""
    try:
        from .ocr import PaddleOcrBackend

        return PaddleOcrBackend(lang)
    except (ImportError, RuntimeError):
        return None


def _load_corrector(api_key: str):
    from .ai import DeepSeekCorrector

    return DeepSeekCorrector(api_key)


def _format_pages(pages: list[int]) -> str:
    return "、".join(str(page) for page in pages) if pages else "无"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bookr-preprocess",
        description="将 PDF 转换为 BookrReader 重排包（*.bookr.json）",
    )
    parser.add_argument("input", nargs="?", help="源 PDF 路径")
    parser.add_argument("--out", help="输出重排包路径（必填）")
    parser.add_argument("--report", help="输出质量报告 JSON 路径")
    parser.add_argument("--text-pdf", help="输出带不可见文字层的 PDF 路径")
    parser.add_argument("--title", help="写入重排包的标题")
    parser.add_argument(
        "--ocr",
        choices=("auto", "always", "never"),
        default="auto",
        help="OCR 策略（默认 auto）",
    )
    parser.add_argument("--ocr-lang", default="ch", help="OCR 语言（默认 ch）")
    parser.add_argument("--dpi", type=int, default=300, help="OCR 渲染 DPI（默认 300）")
    parser.add_argument("--ai-correct", action="store_true", help="使用 DeepSeek 纠错")
    parser.add_argument("--max-pages", type=int, help="仅用于调试：只处理前 N 页")
    parser.add_argument("--force", action="store_true", help="覆盖已存在的输出文件")
    parser.add_argument("--verbose", action="store_true", help="打印全部警告")
    return parser


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)

    if not args.input:
        print("请提供要处理的 PDF 文件", file=sys.stderr)
        return 2
    source = Path(args.input)
    if not source.is_file():
        print(f"输入文件不存在：{source}", file=sys.stderr)
        return 2
    if not args.out:
        print("必须指定 --out 输出路径", file=sys.stderr)
        return 2
    output = Path(args.out)
    if output.exists() and not args.force:
        print(f"输出文件已存在，使用 --force 覆盖：{output}", file=sys.stderr)
        return 2

    corrector = None
    if args.ai_correct:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            print(AI_KEY_MESSAGE, file=sys.stderr)
            return 2
        try:
            corrector = _load_corrector(api_key)
        except (ImportError, RuntimeError):
            print("AI 纠错模块不可用，请检查安装", file=sys.stderr)
            return 3

    ocr_backend = None
    if args.ocr != "never":
        ocr_backend = _load_ocr_backend(args.ocr_lang)
        if ocr_backend is None and args.ocr == "always":
            print(OCR_DEPENDENCY_MESSAGE, file=sys.stderr)
            return 3

    if args.text_pdf:
        Path(args.text_pdf).parent.mkdir(parents=True, exist_ok=True)

    try:
        extractor = PyMuPdfExtractor(str(source))
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    except OSError as exc:
        print(f"无法打开 PDF：{exc}", file=sys.stderr)
        return 2

    options = BuildOptions(
        ocr=args.ocr,
        ocr_lang=args.ocr_lang,
        dpi=args.dpi,
        ai_correct=args.ai_correct,
        title=args.title,
        text_pdf=args.text_pdf,
        max_pages=args.max_pages,
    )

    try:
        result = build_pack(
            source_path=str(source),
            extractor=extractor,
            options=options,
            ocr_backend=ocr_backend,
            corrector=corrector,
        )
    except PackValidationError as exc:
        print("重排包校验失败：", file=sys.stderr)
        for error in exc.errors:
            print(f"- {error}", file=sys.stderr)
        return 2
    except (OSError, RuntimeError) as exc:
        print(f"生成重排包失败：{exc}", file=sys.stderr)
        return 2
    finally:
        extractor.close()

    try:
        _write_json(output, result.pack_dict)
        report_path = None
        if args.report:
            report_path = Path(args.report)
            _write_json(
                report_path,
                {
                    "quality": result.pack_dict["quality"],
                    "source": str(source),
                    "generatedAt": result.pack_dict["generatedAt"],
                },
            )
    except OSError as exc:
        print(f"写入输出文件失败：{exc}", file=sys.stderr)
        return 2

    quality = result.pack_dict["quality"]
    print(f"页数：{quality['pages']}")
    print(f"文本块数：{quality['textBlocks']}")
    print(f"OCR 页：{_format_pages(quality['ocrPages'])}")
    print(f"回退页：{_format_pages(quality['fallbackPages'])}")
    print(f"输出：{output}")
    if report_path is not None:
        print(f"报告：{report_path}")
    if args.text_pdf and result.ocr_lines:
        print(f"文本层 PDF：{args.text_pdf}")

    if result.warnings:
        if args.verbose:
            for warning in result.warnings:
                print(f"警告：{warning}", file=sys.stderr)
        else:
            print(
                f"警告：{len(result.warnings)} 条（使用 --verbose 查看）",
                file=sys.stderr,
            )

    return 0

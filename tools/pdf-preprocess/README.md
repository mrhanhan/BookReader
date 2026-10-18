# bookr-preprocess：本地 PDF 重排包生成工具

`bookr-preprocess` 把 PDF 转成 BookrReader 的重排包（`*.bookr.json`）。上传后，阅读器
可以在「原版」与「重排」之间一键切换：文字按字体、字号、行距、页边距和主题重新排版，
图片、表格、公式仍按源页裁绘显示。

**硬边界：这个工具只在书籍所有者的电脑上运行，不部署到服务器。** 服务器只负责校验并
存储生成好的重排包，不做 OCR、不做版面分析。除显式启用 `--ai-correct` 外，工具不访问
网络。

## 安装

需要 Python 3.10+。

```bash
cd tools/pdf-preprocess
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -e '.[dev]'         # 运行时依赖 PyMuPDF，另装 pytest
```

扫描版 PDF 需要 OCR 时再安装可选依赖：

```bash
pip install -e '.[ocr]'
```

- `[ocr]` 会安装 PaddleOCR、numpy 和 Pillow；PaddleOCR 2.x 与 3.x 的识别结果格式都支持。
- **`paddle`（PaddlePaddle）不在 PyPI 依赖元数据里，必须自行安装。** GPU 版请按
  PaddlePaddle 官方说明选择与 CUDA 匹配的版本；只装 `[ocr]` 而不装 `paddle` 时，
  `--ocr always` 会以退出码 3 报错。缺少 OCR 依赖时 `--ocr auto` 不会中断整本书，
  只是把这些页降级为整页裁绘。

## 命令

```bash
# 带文本层的 PDF
bookr-preprocess book.pdf --out book.bookr.json

# 扫描版 PDF：自动判断需要 OCR 的页，并额外生成可搜索文字层 PDF
bookr-preprocess scan.pdf --out scan.bookr.json --ocr auto --text-pdf scan-searchable.pdf

# 强制 OCR + AI 纠错，并写出质量报告
bookr-preprocess scan.pdf --out scan.bookr.json --ocr always --ai-correct --report scan.report.json
```

AI 纠错需要先设置 `DEEPSEEK_API_KEY`，且必须显式加 `--ai-correct`；未设置密钥时工具在
处理前以退出码 2 退出。

| 参数 | 说明 |
| --- | --- |
| `input` | 源 PDF 路径（位置参数） |
| `--out` | 输出重排包路径（**必填**） |
| `--report` | 额外写出质量报告 JSON |
| `--text-pdf` | 输出带不可见文字层的 PDF；仅当本次有 OCR 结果时才会生成 |
| `--ocr {auto,always,never}` | OCR 策略，默认 `auto` |
| `--ocr-lang` | OCR 语言，默认 `ch` |
| `--dpi` | OCR 渲染 DPI，默认 `300` |
| `--ai-correct` | 用 DeepSeek 纠正 OCR/正文文本 |
| `--max-pages` | 仅调试用：只处理前 N 页 |
| `--force` | 覆盖已存在的输出文件 |
| `--verbose` | 打印全部警告（默认只显示条数） |

源 PDF、输出包、报告和文字层 PDF 不能使用同一路径；输出已存在时必须加 `--force`。

### 批量处理

```bash
mkdir -p packs
for pdf in books/*.pdf; do
  name="$(basename "${pdf%.pdf}")"
  bookr-preprocess "$pdf" --out "packs/$name.bookr.json" --report "packs/$name.report.json" \
    || echo "处理失败：$pdf" >&2
done
```

PowerShell：

```powershell
Get-ChildItem books\*.pdf | ForEach-Object {
  $name = $_.BaseName
  bookr-preprocess $_.FullName --out "packs\$name.bookr.json" --report "packs\$name.report.json"
}
```

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，重排包已写出并通过 schema 校验 |
| `2` | 参数、输入或输出错误：缺少文件/`--out`、路径冲突、输出已存在且未加 `--force`、PDF 无法打开、包校验失败、写文件失败；也包括 `--ai-correct` 未设置 `DEEPSEEK_API_KEY` |
| `3` | 缺少运行依赖：PyMuPDF、PaddleOCR/`paddle`（仅 `--ocr always`），或 AI 纠错模块无法加载 |

## 重排包里有什么

```json
{
  "schemaVersion": 1,
  "source": { "sha256": "<源 PDF 的 SHA-256>", "pageCount": 300 },
  "generatedAt": "2026-10-18T12:00:00.000Z",
  "tool": { "name": "bookr-preprocess", "version": "0.1.0" },
  "quality": { "...": "见下节" },
  "toc": [{ "label": "第一章", "page": 1, "level": 1 }],
  "pages": [
    {
      "page": 1,
      "width": 595.28,
      "height": 841.89,
      "blocks": [
        { "id": "p1-b0", "type": "heading", "level": 1, "text": "第一章", "rect": { "x": 0.1, "y": 0.08, "w": 0.8, "h": 0.03 } },
        { "id": "p1-b1", "type": "paragraph", "text": "……", "rect": { "x": 0.1, "y": 0.12, "w": 0.8, "h": 0.2 } }
      ]
    }
  ]
}
```

- `source.sha256` 是原始 PDF 的哈希。上传时服务端会让它与图书文件比对，包永远不能
  挂到另一本书上。
- `pages` 按阅读顺序编号 `1..n`，`width`/`height` 是源页尺寸（PDF 点）。
- 每个块有页内唯一的 `id`（`p<页>-b<序号>`）和归一化到 `0..1` 的 `rect`（原点在左上）。
- `heading`/`paragraph` 带 `text`，`heading` 另带 `level`（1–6）；有源文本时还会带
  `sourceCharStart`/`sourceCharEnd`（相对该页过滤后文本的 UTF-16 偏移）。
- 全包上限：5000 页、200000 个块、单块文本 20000 个 UTF-16 单元；服务端拒收超过
  32 MiB 的包。

### 块类型

| 类型 | 含义 | 阅读器如何显示 |
| --- | --- | --- |
| `heading` | 标题，带 `level` | 重排后的可选中文字 |
| `paragraph` | 正文段落 | 重排后的可选中文字 |
| `image` | 图片区域 | 从源 PDF 对应页按 `rect` 重新裁绘 |
| `table` | 判定为表格的区域 | 源页裁绘 |
| `formula` | 判定为公式的区域 | 源页裁绘 |
| `fallback` | 整页回退（`rect` 为整页） | 源页整页裁绘 |

**图片不会嵌进重排包**：包只记录位置，阅读器需要原始 PDF 才能绘制图片、表格、公式和
回退页。因此重排包是纯文本 JSON，通常很小；但阅读重排模式仍要求书籍原文件可访问。

整页回退出现在整页无法产生任何文本块时，例如扫描页缺少 OCR 后端、OCR 失败、空页或
提取失败。这类页在重排模式里只能看到原页图像，不能选择文字。

## 质量报告

`--report` 写出：

```json
{
  "quality": {
    "pages": 300,
    "textBlocks": 4210,
    "fallbackPages": [17, 88],
    "ocrPages": [1, 2, 3, 17, 88],
    "avgConfidence": 0.924,
    "warnings": ["第 88 页 OCR 失败（RuntimeError）"]
  },
  "source": "P:\\books\\scan.pdf",
  "generatedAt": "2026-10-18T12:00:00.000Z"
}
```

同一个 `quality` 对象也会写进重排包。字段含义：

| 字段 | 说明 |
| --- | --- |
| `pages` | 实际处理页数（`--max-pages` 时会小于原书页数） |
| `textBlocks` | `heading` + `paragraph` 块总数 |
| `fallbackPages` | 只能整页裁绘、重排模式没有文字的页 |
| `ocrPages` | 实际执行 OCR 的页 |
| `avgConfidence` | OCR 行置信度均值（0–1）；纯文本 PDF 通常为 `null` |
| `warnings` | 提取、OCR、纠错、文字层写入等警告，最多保留 100 条 |

上传前建议：

1. 检查 `fallbackPages`。回退页多来自扫描页；先安装 `[ocr]` 与 `paddle`，再用
   `--ocr auto` 或 `--ocr always` 重新生成。
2. 用 `--verbose` 查看全部警告，或直接打开报告 JSON。目录读取失败、个别页提取失败、
   AI 纠错失败都会出现在这里。
3. 在源 PDF 中逐页翻看回退页，确认它们确实没有可重排的文字（插图、扉页、空白页），
   而不是 OCR 或提取漏掉了正文。

```bash
bookr-preprocess scan.pdf --out scan.bookr.json --report scan.report.json --verbose
```

## 上传重排包

1. 在网页进入 **书架**，找到对应的 PDF 图书。
2. 点击 **编辑**（仅上传者或管理员可以管理重排包）。
3. 在 **重排包** 区块选择生成的 `.bookr.json`（不超过 32 MiB）。
4. 客户端读取包内 `source.sha256` 作为声明哈希，创建上传会话，把文件直传到 MinIO，
   然后调用完成接口。
5. 服务端校验 schema 版本、完整包结构、大小（与声明一致且 ≤32 MiB），以及
   `source.sha256` 是否等于图书原始文件的哈希；同一本书同时只允许一个未完成的上传
   会话。校验通过后新包替换旧包。
6. 上传成功后书架卡片会显示重排标记，阅读页的「重排」按钮变为可用。再次上传会替换
   现有包，也可以在编辑对话框里 **移除重排包**。

重排包不计入书籍上传配额；每本书最多保留一个包。接口细节见根目录 README 的
「阅读器功能」一节。

## 隐私

- 工具在本机运行，除 `--ai-correct` 外不发起任何网络请求；PDF 和生成的包都留在本地。
- 重排包包含书籍全文和目录，请像对待原始书籍一样保管，不要提交到公开仓库或随手分享。
- 启用 `--ai-correct` 后，**只把当前文本块的文字**（每块最多 4000 个 UTF-16 单元）
  发送到 DeepSeek API，不发送页面图像或整本书。超过 4000 字符的块会保持原样。
- `--text-pdf` 生成的不可见文字层同样包含书籍内容，按原书敏感度处理。

## 限制

- 版面分析是启发式规则，**没有捆绑 Docling/MinerU 等重型版面模型**。多栏、脚注、
  侧边栏、跨页图表可能合并错位；标题层级只按字号和加粗粗略判断。
- `table`/`formula` 只是分类标签，阅读器一律按源页裁绘显示，不会重排表格内容；
  检测规则（连续两个以上空格判为表格、公式符号计数）可能误判或漏判。
- 图片、表格、公式和回退页都需要原始 PDF 才能显示；重排包本身不含图像。
- AI 纠错会改变文本长度，而 `sourceCharStart`/`sourceCharEnd` 仍指向纠错前的文本，
  因此被纠错块内部的划线只能定位到“块级近似”位置。单次请求上限 4000 字符，超长块
  不纠错。
- 加密或受密码保护的 PDF 需要先解密，否则可能无法打开或提取不到文本。
- `--max-pages` 只用于快速调试：它生成的包只覆盖前 N 页，不要上传。

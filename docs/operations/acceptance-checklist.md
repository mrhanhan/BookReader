# 验收清单

对应设计文档 §13 的 11 条验收标准。自动化证据给出仓库内的 spec 与用例名，可直接重复运行；
无法自动化的部分（真实计时、三端人工走查、恢复演练）列出手动步骤，执行后填写「记录时间 / 结果」。

**证据类型说明**

- **自动化**：`pnpm exec turbo run typecheck test` 与/或 `pnpm --filter @bookr/web exec playwright test`。
- **手动**：需要真实设备、生产级网络或季度演练；结果写入本表，日志/截图另行归档。
- **混合**：功能由自动化覆盖，性能或真机体验需人工确认。

| # | 验收标准（设计 §13） | 证据类型 | 自动化证据 / 手动步骤 | 记录时间 / 结果 |
|---|---|---|---|---|
| 13.1 | 上传 300 页文字版 PDF，10 秒内可打开；原版模式可选中、复制、划线、加批注 | 混合 | `apps/web/e2e/reader.spec.ts` › `reads a PDF, highlights, annotates, bookmarks and restores progress`（`reader.pdf` 为 300 页可选中文字版）；`packages/reader-core/src/__tests__/pdf-engine.test.ts`、`pdf-selection.test.ts`；复制与确认提示见 `apps/web/src/features/reader/__tests__/reader-annotations.test.tsx:165-177` › `copies the selection and shows a confirmation toast`（断言 `navigator.clipboard.writeText`）。**手动**：在目标服务器上冷启动打开该 300 页 PDF，用秒表记录从点击到首屏可交互的时间（目标 ≤10s）。 | |
| 13.2 | 重排模式可切换，字体/字号/行距/主题可调；切回原版位置不丢失（误差 ≤1 页） | 自动化 | `apps/web/e2e/reflow.spec.ts` › `reads a PDF in reflow mode, keeps its page across modes and saves a reflow highlight`；`packages/reader-core/src/__tests__/reflow-engine.test.ts`、`pdf-engine.test.ts`（重排 locator 映射回源页）。 | |
| 13.3 | 同一账号三端：手机划线后电脑 5 秒内出现；断网记笔记联网后自动合并、无丢失 | 自动化 | `apps/web/e2e/sync.spec.ts` › `同一账号的划线在另一台设备 5 秒内出现`、`离线写入在联网后合并到另一台设备`、`新设备首次同步即看到批注、书签与阅读位置`；服务端 `apps/server/test/sync-*.test.ts`。 | |
| 13.4 | 选中段落请求解释，首字 ≤3 秒返回，解释引用本页上下文 | 混合 | `apps/web/e2e/ai.spec.ts` › `explains a selection and keeps the thread for follow-ups`；服务端 `apps/server/test/ai-context.test.ts`（上下文只来自本页/本章）、`ai-gateway.test.ts`（流式首包）。**手动**：配置真实服务商后测量首字延迟（目标 ≤3s），并抽查回答引用了本页内容。 | |
| 13.5 | 单日有效阅读 ≥10 分钟计入当天；连续天数在跨天、跨时区下正确 | 自动化 | `apps/web/e2e/stats.spec.ts` › `counts a qualified day and draws the thirty-day chart`、`adds consecutive qualified days into one streak`；服务端 `stats-time.test.ts`、`stats-aggregate.test.ts`（跨午夜拆分、时区重建）。 | |
| 13.6 | 笔记库可全文搜索，按书/标签筛选、跳回原文、导出 Markdown | 自动化 | `apps/web/e2e/notes.spec.ts` › `searches, filters and jumps back to the source note`、`exports the filtered notes as markdown`；服务端 `notes-list.test.ts`、`notes-export.test.ts`。 | |
| 13.7 | 扫描版 PDF 经预处理后可选中文字并划线 | 混合 | `tools/pdf-preprocess/tests/test_build.py` › `test_auto_ocr_turns_a_scanned_page_into_text`、`test_ocr_never_leaves_scanned_pages_as_fallbacks`；`apps/web/e2e/reflow.spec.ts`（包上传后重排阅读）。**手动**：用一份真实扫描书执行 `bookr-preprocess --ocr auto`，上传后在重排模式选中划线。 | |
| 13.8 | 模拟数据库损坏，可从备份恢复到最近一次成功备份，笔记与进度完整 | 手动 | 季度恢复演练：`scripts/restore-drill.sh` 恢复最近 dump 到临时库并核对 8 张核心表行数与 MinIO manifest，输出 `PASS`/`FAIL` 到 `backups/drills/<时间戳>.log`；完整恢复步骤见 README §7.3/§7.4。每季度至少一次 `PASS`，并抽查登录、书架、PDF/EPUB 打开与最近阅读记录。 | |
| 13.9 | 网页、Windows 桌面、Android 三端界面符合「纸墨书房」设计语言，阅读页无多余干扰 | 手动 | 三端截图归档并人工走查：Web（360px 与桌面宽度）、Windows 安装包、Android APK；对照设计文档的字体、配色与阅读页工具栏。PWA 可安装性由 `apps/web/e2e/pwa.spec.ts` 自动覆盖（清单、`display: standalone`、三个 PNG 图标）。 | |
| 13.10 | 成员 A 上传的书 B 可见可读；B 的笔记与进度对 A 不可见；B 不能删除 A 的书 | 自动化 | 服务端 `apps/server/test/books.test.ts` › `lists books uploaded by other members in the shared shelf`、`forbids a member from editing or deleting another member's book`；`sync-*.test.ts` 与 `notes-list.test.ts` 的按用户隔离断言。 | |
| 13.11 | 断网时最近 5 本可打开阅读与记笔记；清理离线缓存不影响未同步的笔记 | 自动化 | `apps/web/e2e/sync.spec.ts` › `下载到本机的书离线可读，清理缓存后明确提示`、`在线打开过的书自动缓存，断网 reload 后仍可打开`；`apps/web/src/offline/__tests__/book-source.test.ts`、`cache-manager.test.ts`（LRU 5 本、固定书不淘汰、`clearing the cache leaves annotations, bookmarks, progress and outbox intact`）。 | |

## 执行记录

| 日期 | 执行人 | 范围 | 结果 | 证据位置 |
|---|---|---|---|---|
| | | | | |

## 每次发布前的最小集合

1. `pnpm exec turbo run typecheck test` 全绿。
2. `pnpm --filter @bookr/web exec playwright test` 全绿（只对一次性测试栈运行）。
3. `pnpm check:native` 六项 OK。
4. `curl -fsS <入口>/healthz` 与 `/readyz` 均返回 200。
5. 本季度恢复演练日志为 `PASS`；若已过期，先执行 `scripts/restore-drill.sh`。
6. 手动项（13.1 计时、13.4 首字延迟、13.7 真实扫描书、13.9 三端走查）在本次发布周期内已记录结果。

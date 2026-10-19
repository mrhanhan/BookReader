import { useId } from 'react';
import type {
  EpubFlow,
  EpubFontFamily,
  PdfLayoutMode,
  ReaderEngineKind,
  ReaderSettings,
  ReflowFontFamily,
} from '@bookr/reader-core';
import { READER_THEME_OPTIONS } from './colors';

export interface SettingsPanelProps {
  kind: ReaderEngineKind;
  settings: ReaderSettings;
  onChange: (next: ReaderSettings) => void;
  onClose: () => void;
}

const PDF_MODES: Array<{ value: PdfLayoutMode; label: string }> = [
  { value: 'continuous', label: '连续' },
  { value: 'single', label: '单页' },
  { value: 'double', label: '双页' },
];

const ZOOM_OPTIONS: Array<{ value: string; zoom: ReaderSettings['pdf']['zoom']; label: string }> = [
  { value: 'fit-width', zoom: 'fit-width', label: '适应宽度' },
  { value: 'fit-page', zoom: 'fit-page', label: '适应页面' },
  { value: '0.75', zoom: 0.75, label: '75%' },
  { value: '1', zoom: 1, label: '100%' },
  { value: '1.25', zoom: 1.25, label: '125%' },
  { value: '1.5', zoom: 1.5, label: '150%' },
];

const EPUB_FLOWS: Array<{ value: EpubFlow; label: string }> = [
  { value: 'paginated', label: '分页' },
  { value: 'scrolled', label: '滚动' },
];

const EPUB_FONTS: Array<{ value: EpubFontFamily; label: string }> = [
  { value: 'serif', label: '衬线' },
  { value: 'sans', label: '无衬线' },
];

const REFLOW_FONTS: Array<{ value: ReflowFontFamily; label: string }> = [
  { value: 'serif', label: '衬线' },
  { value: 'sans', label: '黑体' },
];

const CROP_SIDES = [
  { key: 'top', label: '裁边上边' },
  { key: 'right', label: '裁边右边' },
  { key: 'bottom', label: '裁边下边' },
  { key: 'left', label: '裁边左边' },
] as const;

function zoomValue(zoom: ReaderSettings['pdf']['zoom']): string {
  return typeof zoom === 'number' ? String(zoom) : zoom;
}

function numeric(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Reading preferences; every change is persisted and pushed to the engine. */
export function SettingsPanel({ kind, settings, onChange, onClose }: SettingsPanelProps) {
  const idPrefix = useId();
  const fieldId = (name: string) => `${idPrefix}-${name}`;

  function update(patch: Partial<ReaderSettings>): void {
    onChange({ ...settings, ...patch });
  }

  function updatePdf(patch: Partial<ReaderSettings['pdf']>): void {
    update({ pdf: { ...settings.pdf, ...patch } });
  }

  function updateEpub(patch: Partial<ReaderSettings['epub']>): void {
    update({ epub: { ...settings.epub, ...patch } });
  }

  function updateReflow(patch: Partial<ReaderSettings['reflow']>): void {
    update({ reflow: { ...settings.reflow, ...patch } });
  }

  return (
    <aside className="reader-panel reader-settings" aria-label="阅读设置">
      <header className="reader-panel-header">
        <h2 className="reader-panel-title">设置</h2>
        <button type="button" className="reader-panel-close" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="reader-panel-body">
        <section className="reader-setting-group" aria-labelledby={fieldId('theme')}>
          <h3 id={fieldId('theme')} className="reader-setting-label">
            主题
          </h3>
          <div className="reader-theme-row">
            {READER_THEME_OPTIONS.map((theme) => (
              <button
                key={theme.value}
                type="button"
                aria-label={theme.ariaLabel}
                aria-pressed={settings.theme === theme.value}
                className="reader-theme-swatch"
                style={{ backgroundColor: theme.swatch, color: theme.ink }}
                onClick={() => update({ theme: theme.value })}
              >
                {theme.label}
              </button>
            ))}
          </div>
        </section>

        <section className="reader-setting-group">
          <label className="reader-setting-label" htmlFor={fieldId('brightness')}>
            亮度
          </label>
          <input
            id={fieldId('brightness')}
            type="range"
            min={0.6}
            max={1.2}
            step={0.05}
            value={settings.brightness}
            onChange={(event) => update({ brightness: Number(event.target.value) })}
          />
        </section>

        {kind === 'pdf' ? (
          <>
            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('pdf-mode')}>
                页面布局
              </label>
              <select
                id={fieldId('pdf-mode')}
                value={settings.pdf.mode}
                onChange={(event) =>
                  updatePdf({ mode: event.target.value as PdfLayoutMode })
                }
              >
                {PDF_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('zoom')}>
                缩放
              </label>
              <select
                id={fieldId('zoom')}
                value={zoomValue(settings.pdf.zoom)}
                onChange={(event) => {
                  const selected = ZOOM_OPTIONS.find(
                    (option) => option.value === event.target.value,
                  );
                  if (selected) updatePdf({ zoom: selected.zoom });
                }}
              >
                {ZOOM_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-check">
                <input
                  type="checkbox"
                  checked={settings.pdf.crop === 'auto'}
                  onChange={(event) =>
                    updatePdf({ crop: event.target.checked ? 'auto' : 'none' })
                  }
                />
                自动裁边
              </label>

              {CROP_SIDES.map((side) => (
                <div key={side.key} className="reader-setting-row">
                  <label className="reader-setting-label" htmlFor={fieldId(`crop-${side.key}`)}>
                    {side.label}
                  </label>
                  <input
                    id={fieldId(`crop-${side.key}`)}
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={settings.pdf.cropAdjust[side.key]}
                    onChange={(event) =>
                      updatePdf({
                        cropAdjust: {
                          ...settings.pdf.cropAdjust,
                          [side.key]: numeric(event.target.value, 0),
                        },
                      })
                    }
                  />
                </div>
              ))}
            </section>

            <p className="reader-setting-hint">
              放大到页面比屏幕宽之后，可以直接拖动页面；按住 Alt
              拖动则改为选择文字。手机上一根手指拖动即可平移。
            </p>
          </>
        ) : kind === 'epub' ? (
          <>
            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-flow')}>
                排版
              </label>
              <select
                id={fieldId('epub-flow')}
                value={settings.epub.flow}
                onChange={(event) =>
                  updateEpub({ flow: event.target.value as EpubFlow })
                }
              >
                {EPUB_FLOWS.map((flow) => (
                  <option key={flow.value} value={flow.value}>
                    {flow.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-font')}>
                字体
              </label>
              <select
                id={fieldId('epub-font')}
                value={settings.epub.fontFamily}
                onChange={(event) =>
                  updateEpub({ fontFamily: event.target.value as EpubFontFamily })
                }
              >
                {EPUB_FONTS.map((font) => (
                  <option key={font.value} value={font.value}>
                    {font.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-size')}>
                字号
              </label>
              <input
                id={fieldId('epub-size')}
                type="range"
                min={14}
                max={28}
                step={1}
                value={settings.epub.fontSize}
                onChange={(event) => updateEpub({ fontSize: Number(event.target.value) })}
              />
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-line-height')}>
                行距
              </label>
              <input
                id={fieldId('epub-line-height')}
                type="range"
                min={1.4}
                max={2.4}
                step={0.1}
                value={settings.epub.lineHeight}
                onChange={(event) => updateEpub({ lineHeight: Number(event.target.value) })}
              />
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-margin')}>
                页边距
              </label>
              <input
                id={fieldId('epub-margin')}
                type="range"
                min={2}
                max={12}
                step={1}
                value={settings.epub.margin}
                onChange={(event) => updateEpub({ margin: Number(event.target.value) })}
              />
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('epub-spread')}>
                分栏
              </label>
              <select
                id={fieldId('epub-spread')}
                value={settings.epub.spread}
                onChange={(event) =>
                  updateEpub({ spread: event.target.value === 'auto' ? 'auto' : 'none' })
                }
              >
                <option value="none">单栏</option>
                <option value="auto">双栏</option>
              </select>
            </section>
          </>
        ) : (
          <>
            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('reflow-font')}>
                字体
              </label>
              <select
                id={fieldId('reflow-font')}
                value={settings.reflow.fontFamily}
                onChange={(event) =>
                  updateReflow({ fontFamily: event.target.value as ReflowFontFamily })
                }
              >
                {REFLOW_FONTS.map((font) => (
                  <option key={font.value} value={font.value}>
                    {font.label}
                  </option>
                ))}
              </select>
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('reflow-size')}>
                字号
              </label>
              <input
                id={fieldId('reflow-size')}
                type="range"
                min={16}
                max={28}
                step={1}
                value={settings.reflow.fontSize}
                onChange={(event) => updateReflow({ fontSize: Number(event.target.value) })}
              />
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('reflow-line-height')}>
                行距
              </label>
              <input
                id={fieldId('reflow-line-height')}
                type="range"
                min={1.5}
                max={2.4}
                step={0.1}
                value={settings.reflow.lineHeight}
                onChange={(event) => updateReflow({ lineHeight: Number(event.target.value) })}
              />
            </section>

            <section className="reader-setting-group">
              <label className="reader-setting-label" htmlFor={fieldId('reflow-margin')}>
                页边距
              </label>
              <input
                id={fieldId('reflow-margin')}
                type="range"
                min={2}
                max={16}
                step={1}
                value={settings.reflow.margin}
                onChange={(event) => updateReflow({ margin: Number(event.target.value) })}
              />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

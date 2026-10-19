import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Input, cn } from '@bookr/ui';
import type { SystemSettingsDto, UpdateSystemSettingsInput } from '@bookr/shared';
import {
  useAdminAiConfig,
  useSystemSettings,
  useUpdateAdminAiConfig,
  useUpdateSystemSettings,
} from '../../api/admin';
import type { AdminAiConfig, UpdateAdminAiConfig } from '../../api/admin';
import { messageForApiError } from '../../lib/errorMessages';
import { Toast } from '../bookshelf/Toast';
import { TIMEZONE_OPTIONS } from '../settings/timezones';
import { AdminTabs } from './AdminTabs';

const panelClass = 'rounded-lg border border-border bg-surface/70 p-5';
const alertClass =
  'rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight';
const selectClass =
  'min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:max-w-xs';

/** A failed read with a retry affordance shared by both settings sections. */
function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className={cn(alertClass, 'mt-4 flex flex-wrap items-center gap-3')}>
      <span>{messageForApiError(error)}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

/** Registration switch plus the timezone applied to newly created accounts. */
function RegistrationSettings({ settings }: { settings: SystemSettingsDto }) {
  const updateSettings = useUpdateSystemSettings();
  const [registrationEnabled, setRegistrationEnabled] = useState(settings.registrationEnabled);
  const [timezone, setTimezone] = useState(settings.defaultTimezone);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissToast = useCallback(() => setNotice(null), []);

  // A save or another administrator's change replaces the drafts with the
  // stored values; primitive dependencies keep typing untouched otherwise.
  useEffect(() => {
    setRegistrationEnabled(settings.registrationEnabled);
  }, [settings.registrationEnabled]);
  useEffect(() => {
    setTimezone(settings.defaultTimezone);
  }, [settings.defaultTimezone]);

  const options = TIMEZONE_OPTIONS.some((option) => option.value === timezone)
    ? TIMEZONE_OPTIONS
    : [{ value: timezone, label: timezone }, ...TIMEZONE_OPTIONS];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const input: UpdateSystemSettingsInput = { registrationEnabled, defaultTimezone: timezone };
    updateSettings.mutate(input, {
      onSuccess: () => setNotice('设置已保存'),
      onError: (cause) => setError(messageForApiError(cause)),
    });
  }

  return (
    <>
      <p className="mt-1 text-xs text-muted">注册开关只影响新成员，已有账号不受影响。</p>

      <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
        <div>
          <label className="flex w-fit items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={registrationEnabled}
              disabled={updateSettings.isPending}
              onChange={(event) => setRegistrationEnabled(event.target.checked)}
              className="size-4 rounded border-border accent-accent"
            />
            允许新成员注册
          </label>
          <p className="mt-1 text-xs text-muted">
            关闭后，即使持有邀请码也无法注册新成员
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="admin-default-timezone" className="text-sm font-medium text-ink">
            默认时区
          </label>
          <select
            id="admin-default-timezone"
            value={timezone}
            disabled={updateSettings.isPending}
            onChange={(event) => setTimezone(event.target.value)}
            className={selectClass}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.value}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted">只作用于新注册成员，修改不会回算已有成员的统计。</p>
        </div>

        {error ? (
          <p role="alert" className={alertClass}>
            {error}
          </p>
        ) : null}

        <div>
          <Button type="submit" loading={updateSettings.isPending}>
            保存设置
          </Button>
        </div>
      </form>

      {notice ? <Toast message={notice} onDismiss={dismissToast} /> : null}
    </>
  );
}

interface AiDraft {
  baseUrl: string;
  chatModel: string;
  reasonerModel: string;
  apiKey: string;
}

/** Provider form; the API key is write-only and never read back. */
function AiProviderForm({ view }: { view: AdminAiConfig }) {
  const updateConfig = useUpdateAdminAiConfig();
  const [draft, setDraft] = useState<AiDraft>({
    baseUrl: view.baseUrl ?? '',
    chatModel: view.chatModel ?? '',
    reasonerModel: view.reasonerModel ?? '',
    apiKey: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissToast = useCallback(() => setNotice(null), []);

  const statusLabel = view.fakeProvider ? '本地假提供方' : view.configured ? '已配置' : '未配置';
  const disabled = updateConfig.isPending || view.fakeProvider;

  function setField(field: keyof AiDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Blank fields keep their stored values; the API accepts a partial patch.
    const body: UpdateAdminAiConfig = {};
    const baseUrl = draft.baseUrl.trim();
    const chatModel = draft.chatModel.trim();
    const reasonerModel = draft.reasonerModel.trim();
    const apiKey = draft.apiKey.trim();
    if (baseUrl !== '') body.baseUrl = baseUrl;
    if (chatModel !== '') body.chatModel = chatModel;
    if (reasonerModel !== '') body.reasonerModel = reasonerModel;
    if (apiKey !== '') body.apiKey = apiKey;

    if (Object.keys(body).length === 0) {
      setError('请至少填写一项 AI 配置');
      return;
    }

    updateConfig.mutate(body, {
      onSuccess: () => {
        // The key is write-only: never keep it in the form after saving.
        setDraft((current) => ({ ...current, apiKey: '' }));
        setNotice('AI 配置已保存');
      },
      onError: (cause) => setError(messageForApiError(cause)),
    });
  }

  return (
    <form className="mt-4 flex flex-col gap-4" onSubmit={submit}>
      <p className="text-sm text-ink">
        当前状态：
        <span className={view.configured ? 'text-accent' : 'text-muted'}>{statusLabel}</span>
      </p>
      {view.fakeProvider ? (
        <p className="text-xs text-muted">
          本地假提供方只用于测试，不会发起真实请求，也无法通过此表单修改。
        </p>
      ) : null}

      <Input
        label="Base URL"
        value={draft.baseUrl}
        disabled={disabled}
        autoComplete="off"
        placeholder="https://api.example.com/v1"
        onChange={(event) => setField('baseUrl', event.target.value)}
      />
      <Input
        label="对话模型"
        value={draft.chatModel}
        disabled={disabled}
        autoComplete="off"
        placeholder="例如 deepseek-chat"
        onChange={(event) => setField('chatModel', event.target.value)}
      />
      <Input
        label="推理模型"
        value={draft.reasonerModel}
        disabled={disabled}
        autoComplete="off"
        placeholder="例如 deepseek-reasoner"
        onChange={(event) => setField('reasonerModel', event.target.value)}
      />
      <Input
        label="API Key"
        type="password"
        value={draft.apiKey}
        disabled={disabled}
        autoComplete="new-password"
        placeholder={view.hasApiKey ? '已保存，留空不修改' : '输入 API Key'}
        hint={view.hasApiKey ? '已保存 Key，留空则保持原 Key 不变。' : '至少 8 位；保存后不会再显示。'}
        onChange={(event) => setField('apiKey', event.target.value)}
      />

      {error ? (
        <p role="alert" className={alertClass}>
          {error}
        </p>
      ) : null}

      <div>
        <Button type="submit" loading={updateConfig.isPending} disabled={disabled}>
          保存 AI 配置
        </Button>
      </div>

      {notice ? <Toast message={notice} onDismiss={dismissToast} /> : null}
    </form>
  );
}

function AiProviderSection() {
  const aiQuery = useAdminAiConfig();

  return (
    <section aria-labelledby="ai-provider-title" className={panelClass}>
      <h2 id="ai-provider-title" className="font-serif text-lg text-ink">
        AI 服务商
      </h2>
      <p className="mt-1 text-xs text-muted">
        Key 只保存在服务器，保存后不会再返回给浏览器；留空表示保持现有 Key。
      </p>

      {aiQuery.isPending ? (
        <p role="status" className="mt-4 text-sm tracking-widest text-muted">
          正在读取 AI 配置…
        </p>
      ) : aiQuery.isError ? (
        <QueryError error={aiQuery.error} onRetry={() => aiQuery.refetch()} />
      ) : (
        <AiProviderForm view={aiQuery.data} />
      )}
    </section>
  );
}

function RegistrationSection() {
  const settingsQuery = useSystemSettings();

  return (
    <section aria-labelledby="registration-settings-title" className={panelClass}>
      <h2 id="registration-settings-title" className="font-serif text-lg text-ink">
        注册与默认时区
      </h2>

      {settingsQuery.isPending ? (
        <p role="status" className="mt-4 text-sm tracking-widest text-muted">
          正在读取系统设置…
        </p>
      ) : settingsQuery.isError ? (
        <QueryError error={settingsQuery.error} onRetry={() => settingsQuery.refetch()} />
      ) : (
        <RegistrationSettings settings={settingsQuery.data} />
      )}
    </section>
  );
}

/** System-wide registration, timezone and AI provider configuration. */
export function AdminSettingsPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">系统设置</h1>
        <p className="mt-1 text-sm text-muted">决定谁可以加入书房，以及 AI 伴读连接哪里。</p>
      </div>

      <AdminTabs />

      <RegistrationSection />
      <AiProviderSection />
    </section>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, Input } from '@bookr/ui';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { AuthShell } from './AuthShell';

interface FieldErrors {
  inviteCode?: string;
  username?: string;
  password?: string;
  displayName?: string;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors: FieldErrors = {};
    const trimmedInvite = inviteCode.trim();
    const trimmedUsername = username.trim();
    const trimmedName = displayName.trim();

    if (trimmedInvite.length < 6) nextErrors.inviteCode = '请输入有效的邀请码';
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      nextErrors.username = '用户名为 3–32 位字母、数字或下划线';
    }
    if (trimmedName.length === 0) nextErrors.displayName = '请输入显示名称';
    if (password.length < 10) nextErrors.password = '密码至少需要 10 位';

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await register({
        inviteCode: trimmedInvite,
        username: trimmedUsername,
        password,
        displayName: trimmedName,
      });
      navigate('/', { replace: true });
    } catch (error) {
      setFormError(messageForApiError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="注册书房账号"
      subtitle="这里采用邀请制，请先向管理员索取邀请码。"
      footer={
        <>
          已经有账号？
          <Link to="/login" className="ml-1 text-accent underline-offset-4 hover:underline">
            返回登录
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
          >
            {formError}
          </p>
        ) : null}

        <Input
          label="邀请码"
          name="inviteCode"
          autoComplete="off"
          value={inviteCode}
          onChange={(event) => setInviteCode(event.target.value)}
          error={fieldErrors.inviteCode}
          hint="由管理员发放"
        />
        <Input
          label="用户名"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          error={fieldErrors.username}
          hint="3–32 位字母、数字或下划线，用于登录"
        />
        <Input
          label="显示名称"
          name="displayName"
          autoComplete="nickname"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          error={fieldErrors.displayName}
        />
        <Input
          label="密码"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          hint="至少 10 位"
        />

        <Button type="submit" loading={submitting} className="mt-2 w-full">
          注册
        </Button>
      </form>
    </AuthShell>
  );
}

import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Input } from '@bookr/ui';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { AuthShell } from './AuthShell';

interface FieldErrors {
  username?: string;
  password?: string;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors: FieldErrors = {};
    if (!username.trim()) nextErrors.username = '请输入用户名';
    if (!password) nextErrors.password = '请输入密码';
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await login({ username: username.trim(), password });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (error) {
      setFormError(messageForApiError(error, 'login'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="登录书房"
      subtitle="回到你的书架，继续上次的阅读。"
      footer={
        <>
          还没有账号？
          <Link to="/register" className="ml-1 text-accent underline-offset-4 hover:underline">
            使用邀请码注册
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
          label="用户名"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          error={fieldErrors.username}
        />
        <Input
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
        />

        <Button type="submit" loading={submitting} className="mt-2 w-full">
          登录
        </Button>
      </form>
    </AuthShell>
  );
}

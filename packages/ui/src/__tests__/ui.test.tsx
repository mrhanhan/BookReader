import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { Button } from '../components/Button';
import { tokens } from '../tokens';

it('pins the paper-ink palette', () => {
  expect(tokens.paper).toBe('#F6F1E7');
  expect(tokens.ink).toBe('#2B2620');
  expect(tokens.accent).toBe('#8C5A3B');
});

it('disables the button while loading and keeps its label', () => {
  render(<Button loading>保存</Button>);
  const button = screen.getByRole('button', { name: '保存' });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('aria-busy', 'true');
});

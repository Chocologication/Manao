import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { ThinkingBlock } from './ThinkingBlock';
afterEach(cleanup);
it('toggles thinking visibility while retaining the exact text in the DOM', async () => {
  render(<ThinkingBlock text={'# literal thought\n<script>safe</script>'} active={false} />);
  const content = screen.getByText(/literal thought/);
  expect(content).toBeInTheDocument();
  expect(content).not.toBeVisible();
  await userEvent.click(screen.getByText('思考过程'));
  expect(content).toBeVisible();
  expect(content.textContent).toBe('# literal thought\n<script>safe</script>');
  await userEvent.click(screen.getByText('思考过程'));
  expect(content).not.toBeVisible();
  expect(content).toBeInTheDocument();
  expect(document.querySelector('script, h1')).toBeNull();
});
it('marks active and incomplete thinking without confusing model length with missing history', async () => {
  render(<ThinkingBlock text="pending thought" active incomplete />);
  expect(screen.getByText('思考中')).toBeVisible();
  expect(screen.getByText('还有更早内容')).toBeVisible();
  expect(screen.queryByText('模型响应达到输出上限，本条内容可能不完整')).not.toBeInTheDocument();
});

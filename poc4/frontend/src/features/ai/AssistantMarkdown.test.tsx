import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { AssistantMarkdown } from './AssistantMarkdown';
afterEach(cleanup);
it('renders assistant headings, lists, fences, tables, quotes, inline code and safe links', () => {
  render(<AssistantMarkdown text={'# 完成\n\n- 已验证\n\n~~~java\nclass A {}\n~~~\n\n| 文件 | 状态 |\n| --- | --- |\n| A | OK |\n\n> 引用\n\n`inline` [source](https://example.com)'} />);
  expect(screen.getByRole('heading', { name: '完成' })).toBeVisible();
  expect(screen.getByRole('list')).toBeVisible();
  expect(screen.getByText('class A {}').tagName).toBe('CODE');
  expect(screen.getByRole('table')).toBeVisible();
  expect(screen.getByText('引用').tagName).toBe('P');
  expect(screen.getByText('inline').tagName).toBe('CODE');
  expect(screen.getByRole('link', { name: 'source' })).toHaveAttribute('href', 'https://example.com');
});
it('displays raw HTML literally and removes dangerous URL protocols', () => {
  const h = render(<AssistantMarkdown text={'<script>globalThis.hacked=true</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,test)'} />);
  expect(h.container.firstElementChild).toBeVisible();
  expect(h.container.firstElementChild).toHaveTextContent('<script>globalThis.hacked=true</script>');
  expect(h.container.firstElementChild).toHaveTextContent('<img src=x onerror=alert(1)>');
  expect(h.container.querySelector('script, img')).toBeNull();
  for (const link of h.container.querySelectorAll('a')) expect(link.getAttribute('href')).toBe('');
});
it('renders an unfinished fence as code while more text is pending', () => {
  const h = render(<AssistantMarkdown text={'~~~java\nclass A {}'} />);
  expect(screen.getByText('class A {}').tagName).toBe('CODE');
  h.rerender(<AssistantMarkdown text={'~~~java\nclass A {}\n~~~\n\n## 完成'} />);
  expect(screen.getByRole('heading', { name: '完成' })).toBeVisible();
});

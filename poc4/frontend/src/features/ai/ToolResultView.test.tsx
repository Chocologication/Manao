import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentToolCallResult } from '@/contracts/agentTask';
import { ToolResultView } from './AgentTaskPanel';

const SHA256 = 'a'.repeat(64);
function show(toolName: string, data: AgentToolCallResult['data']) {
  return render(<ToolResultView result={{ toolCallId: 'call_original', toolName, data }} />);
}
afterEach(cleanup);

describe('file tool results', () => {
  it('renders read_file content and paths literally while omitting unknown fields', () => {
    const content = '中文😀\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>';
    const path = 'src/<h1>示例</h1>.java';
    show('read_file', { path, content, sha256: SHA256, workerPath: 'PRIVATE_WORKER_PATH' });
    expect(screen.getByText((_, node) => node?.tagName === 'PRE' && node.textContent === content)).toBeInTheDocument();
    expect(screen.getByText(`路径：${path}`)).toBeInTheDocument();
    expect(screen.getByText(`SHA-256: ${SHA256}`)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE_WORKER_PATH/)).not.toBeInTheDocument();
    expect(document.querySelector('script, img, h1')).toBeNull();
    expect(screen.queryByText('Result unavailable')).not.toBeInTheDocument();
  });

  it('distinguishes an empty read_file from a missing result', () => {
    show('read_file', { path: 'empty.txt', content: '', sha256: SHA256 });
    expect(screen.getByText('文件内容为空')).toBeInTheDocument();
    expect(screen.getByText('路径：empty.txt')).toBeInTheDocument();
  });

  it('renders directory and file entries as text without passing through extra fields', () => {
    show('list_files', {
      directory: 'src', hasMore: false,
      entries: [
        { path: 'src/demo', name: 'demo', kind: 'directory', hidden: false, sizeBytes: null, hasChildren: true },
        { path: 'src/<img>.java', name: '<img>.java', kind: 'file', hidden: false, sizeBytes: 42, hasChildren: null, signature: 'PRIVATE_SIGNATURE' },
      ], executionUid: 'PRIVATE_UID',
    });
    expect(screen.getByText('目录：src')).toBeInTheDocument();
    expect(screen.getByText('src/demo')).toBeInTheDocument();
    expect(screen.getByText('src/<img>.java')).toBeInTheDocument();
    expect(screen.getByText('目录')).toBeInTheDocument();
    expect(screen.getByText('文件')).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE_SIGNATURE|PRIVATE_UID/)).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows a successful empty root directory explicitly', () => {
    show('list_files', { directory: '', entries: [], hasMore: false });
    expect(screen.getByText('目录：/')).toBeInTheDocument();
    expect(screen.getByText('目录为空')).toBeInTheDocument();
  });

  it.each([{ entries: [] }, { entries: [{ path: 'src/demo', name: 'demo', kind: 'directory', hidden: false, sizeBytes: null, hasChildren: true }] }])(
    'marks truncated listings even when no entry fits the result bound: $entries', ({ entries }) => {
      show('list_files', { directory: '', entries, hasMore: true });
      expect(screen.getByText('列表已截断，仍有更多条目')).toBeInTheDocument();
      expect(screen.queryByText('目录为空')).not.toBeInTheDocument();
    },
  );

  it('confirms a settled write_file with its path and hash', () => {
    show('write_file', { path: 'src/中文.java', sha256: SHA256, internalId: 'PRIVATE_WRITE_ID' });
    expect(screen.getByText('文件已写入')).toBeInTheDocument();
    expect(screen.getByText('路径：src/中文.java')).toBeInTheDocument();
    expect(screen.getByText(`SHA-256: ${SHA256}`)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE_WRITE_ID/)).not.toBeInTheDocument();
  });

  it.each(['read_file', 'list_files', 'write_file'])('shows a settled %s rejection as a literal tool error', toolName => {
    show(toolName, { error: { code: 'ENTRY_NOT_FOUND', message: '文件不存在 <img src=x>', privateDetail: 'PRIVATE_ERROR' } });
    expect(screen.getByRole('alert')).toHaveTextContent('ENTRY_NOT_FOUND: 文件不存在 <img src=x>');
    expect(document.querySelector('img')).toBeNull();
    expect(screen.queryByText(/PRIVATE_ERROR/)).not.toBeInTheDocument();
    expect(screen.queryByText('文件已写入')).not.toBeInTheDocument();
  });

  it.each([
    ['read_file', { path: 'broken.txt', sha256: SHA256 }],
    ['read_file', { path: 'broken.txt', content: 'not proven', sha256: null }],
    ['list_files', { directory: '', entries: [{ path: 'bad', kind: 'unknown' }], hasMore: false }],
    ['list_files', { directory: '', entries: [], hasMore: 'false' }],
    ['write_file', { path: 'broken.txt' }],
    ['write_file', { path: 'broken.txt', sha256: SHA256, error: { code: 'FAILED' } }],
  ])('reports malformed %s data without presenting successful content', (toolName, data) => {
    show(toolName, data);
    expect(screen.getByRole('alert')).toHaveTextContent('工具结果格式不完整');
    expect(screen.queryByText('文件已写入')).not.toBeInTheDocument();
    expect(screen.queryByText('目录为空')).not.toBeInTheDocument();
    expect(screen.queryByText('not proven')).not.toBeInTheDocument();
  });
});

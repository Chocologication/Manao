import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { pythonBuildData, pythonDependencyData, type AgentToolCallResult } from '@/contracts/agentTask';
import { ToolResultView } from './AgentTaskPanel';

const SHA256 = 'a'.repeat(64);
function show(toolName: string, data: AgentToolCallResult['data']) {
  return render(<ToolResultView result={{ toolCallId: 'call_original', toolName, data }} />);
}
afterEach(cleanup);

const dependency = {
  kind: 'python_dependencies', operationId: 'operation-1', action: 'add', packageName: 'pytest',
  group: 'test', state: 'COMMITTED', changedPaths: ['pyproject.toml', 'uv.lock'],
};
const pythonBuild = {
  goal: 'test', sourceRevision: '9', exitCode: 0, terminationReason: 'Completed', output: 'bounded output',
  cleanupConfirmed: true, language: 'python', checkKind: 'pytest', verificationStatus: 'PASS',
  filesChecked: null, errors: [], testSummary: { tests: 3, failures: 0, errors: 0, skipped: 1, reportComplete: true },
};
const result = (toolName: string, data: Record<string, unknown>): AgentToolCallResult => ({ toolCallId: 'call', toolName, data });

describe('Python dependency results', () => {
  it.each(['main', 'test'])('shows the committed package, %s group and both managed paths', group => {
    show('python_dependencies', { ...dependency, group, podName: 'PRIVATE_POD' });
    expect(screen.getByText('依赖变更')).toBeVisible();
    expect(screen.getByText('包：pytest')).toBeVisible();
    expect(screen.getByText(`依赖组：${group}`)).toBeVisible();
    expect(screen.getByText('操作：添加')).toBeVisible();
    expect(screen.getByText('状态：已提交')).toBeVisible();
    expect(screen.getByText('pyproject.toml')).toBeVisible();
    expect(screen.getByText('uv.lock')).toBeVisible();
    expect(screen.queryByText(/PRIVATE_POD/)).toBeNull();
  });

  it('shows removal and a settled refusal without inventing a commit', () => {
    show('python_dependencies', { ...dependency, action: 'remove' });
    expect(screen.getByText('操作：移除')).toBeVisible();
    cleanup();
    show('python_dependencies', { error: { code: 'DEPENDENCY_REJECTED', message: 'Dependency change was refused' } });
    expect(screen.getByRole('alert')).toHaveTextContent('DEPENDENCY_REJECTED: Dependency change was refused');
    expect(screen.queryByText('状态：已提交')).toBeNull();
  });

  it.each([
    { state: 'PENDING' }, { action: 'ADD' }, { group: 'dev' }, { packageName: '' },
    { changedPaths: ['pyproject.toml'] }, { changedPaths: ['uv.lock', 'uv.lock'] }, { operationId: undefined },
  ])('rejects malformed dependency evidence: %j', invalid => {
    const data = { ...dependency, ...invalid };
    expect(pythonDependencyData(result('python_dependencies', data))).toBeNull();
    show('python_dependencies', data);
    expect(screen.getByRole('alert')).toHaveTextContent('工具结果格式不完整');
    expect(screen.queryByText('状态：已提交')).toBeNull();
  });
});

describe('Python verification results', () => {
  it('shows real pytest counts, exit, report completeness and the checked revision', () => {
    show('build', { ...pythonBuild, namespace: 'PRIVATE_NAMESPACE' });
    expect(screen.getByText('Python 测试')).toBeVisible();
    expect(screen.getByText('验证状态：PASS')).toBeVisible();
    expect(screen.getByText('源码版本：9')).toBeVisible();
    expect(screen.getByText('测试：3 · 失败：0 · 错误：0 · 跳过：1')).toBeVisible();
    expect(screen.getByText('测试报告：完整')).toBeVisible();
    expect(screen.getByText('退出码：').parentElement).toHaveTextContent('0');
    expect(screen.queryByText(/PRIVATE_NAMESPACE/)).toBeNull();
  });

  it('shows syntax checking and literal diagnostics without executing markup', () => {
    show('build', { ...pythonBuild, goal: 'compile', checkKind: 'syntax', verificationStatus: 'FAILED', exitCode: 1,
      filesChecked: 2, testSummary: null, errors: [{ path: 'main.py', message: 'invalid <img src=x>' }] });
    expect(screen.getByText('Python 语法检查')).toBeVisible();
    expect(screen.getByText('验证状态：FAILED')).toBeVisible();
    expect(screen.getByText('已检查文件：2')).toBeVisible();
    expect(screen.getByText('main.py: invalid <img src=x>')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each([
    ['NO_TESTS', '未发现测试', 'pytest', null, null],
    ['SKIPPED', '全部测试跳过', 'pytest', null, { tests: 2, failures: 0, errors: 0, skipped: 2, reportComplete: true }],
    ['UNKNOWN', '验证证据不完整', 'pytest', null, null],
    ['NO_SOURCE', '未发现 Python 源文件', 'syntax', 0, null],
  ])('never turns %s into a pass', (verificationStatus, label, checkKind, filesChecked, testSummary) => {
    show('build', { ...pythonBuild, verificationStatus, checkKind, goal: checkKind === 'syntax' ? 'compile' : 'test',
      exitCode: verificationStatus === 'NO_SOURCE' ? 1 : 0, filesChecked, testSummary });
    expect(screen.getByText(`验证状态：${label}`)).toBeVisible();
    expect(screen.queryByText(/PASS/)).toBeNull();
    if (testSummary === null && checkKind === 'pytest') expect(screen.getByText('测试报告：未取得完整报告')).toBeVisible();
  });

  it.each([
    { verificationStatus: undefined }, { verificationStatus: 'SUCCESS' }, { verificationStatus: { toString: (): string => 'PASS' } }, { filesChecked: undefined },
    { errors: undefined }, { testSummary: undefined }, { filesChecked: -1 }, { exitCode: '0' },
    { errors: [{ path: 'main.py', message: 4 }] }, { testSummary: { tests: 1, failures: 0, errors: 0, skipped: 0 } },
    { testSummary: { tests: 1, failures: 0, errors: 0, skipped: 2, reportComplete: true } },
    { testSummary: { tests: 1, failures: 0, errors: 0, skipped: 0, reportComplete: false } },
    { testSummary: null }, { exitCode: 1 },
  ])('rejects incomplete or contradictory Python evidence: %j', invalid => {
    const data = { ...pythonBuild, ...invalid };
    expect(pythonBuildData(result('build', data))).toBeNull();
    show('build', data);
    expect(screen.getByRole('alert')).toHaveTextContent('验证证据不完整');
    expect(screen.queryByText(/验证状态：PASS/)).toBeNull();
  });

  it('keeps an unknown exit unknown and preserves the legacy Java build view', () => {
    show('build', { ...pythonBuild, exitCode: null, verificationStatus: 'UNKNOWN', testSummary: null });
    expect(screen.getByText('退出码：').parentElement).toHaveTextContent('未知');
    cleanup();
    show('build', { goal: 'test', exitCode: 1, terminationReason: 'Completed', output: 'Java build failed', cleanupConfirmed: true });
    expect(screen.getByText('Java build failed')).toBeVisible();
    expect(screen.getByText('退出码：').parentElement).toHaveTextContent('1');
    expect(screen.queryByText(/Python/)).toBeNull();
  });

  it('shows a settled build refusal without inventing verification evidence', () => {
    show('build', { error: { code: 'AI_BUILD_GOAL_UNSUPPORTED', message: 'Build goal is unsupported' } });
    expect(screen.getByRole('alert')).toHaveTextContent('AI_BUILD_GOAL_UNSUPPORTED: Build goal is unsupported');
    expect(screen.queryByText(/验证状态：PASS/)).toBeNull();
  });
});

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
    expect(screen.queryByText('结果暂不可用')).not.toBeInTheDocument();
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

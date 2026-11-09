import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ValidationResult } from './ToolProgress';

afterEach(cleanup);

const pytest = {
  goal: 'test', language: 'python', checkKind: 'pytest', verificationStatus: 'PASS',
  exitCode: 0, cleanupConfirmed: true, sourceRevision: '7', filesChecked: null, errors: [],
  testSummary: { tests: 3, failures: 0, errors: 0, skipped: 1, reportComplete: true },
};

function show(data: Record<string, unknown>, title = '应用后验证') {
  return render(<ValidationResult title={title} data={data} />);
}

describe('Studio validation evidence', () => {
  it('passes only complete Python evidence with an executed test and confirmed cleanup', () => {
    const view = show(pytest);
    expect(screen.getByText('通过', { exact: true })).toBeVisible();
    expect(view.container.querySelector('.studio-validation')).toHaveClass('is-pass');
  });

  it.each([
    ['FAILED', { ...pytest, verificationStatus: 'FAILED', testSummary: { ...pytest.testSummary, failures: 1 } }, '未通过'],
    ['UNKNOWN', { ...pytest, verificationStatus: 'UNKNOWN', testSummary: null }, '验证证据不完整'],
    ['SKIPPED', { ...pytest, verificationStatus: 'SKIPPED', testSummary: { ...pytest.testSummary, skipped: 3 } }, '全部测试跳过'],
    ['NO_TESTS', { ...pytest, verificationStatus: 'NO_TESTS', testSummary: { ...pytest.testSummary, tests: 0, skipped: 0 } }, '未发现测试'],
    ['missing report', { ...pytest, testSummary: null }, '验证证据不完整'],
    ['incomplete report', { ...pytest, testSummary: { ...pytest.testSummary, reportComplete: false } }, '验证证据不完整'],
    ['contradictory PASS', { ...pytest, testSummary: { ...pytest.testSummary, errors: 1 } }, '验证证据不完整'],
    ['all skipped PASS', { ...pytest, testSummary: { ...pytest.testSummary, skipped: 3 } }, '验证证据不完整'],
  ])('does not turn %s into success even when the process exits zero', (_name, data, label) => {
    const view = show(data);
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    expect(view.container.querySelector('.studio-validation')).not.toHaveClass('is-pass');
    expect(screen.queryByText('通过', { exact: true })).toBeNull();
  });

  it('keeps syntax-only success distinct from a test pass', () => {
    show({ ...pytest, goal: 'compile', checkKind: 'syntax', filesChecked: 2, testSummary: null });
    expect(screen.getByText('语法检查通过', { exact: true })).toBeVisible();
  });

  it('does not call an empty syntax check successful', () => {
    const view = show({ ...pytest, goal: 'compile', checkKind: 'syntax', verificationStatus: 'NO_SOURCE', filesChecked: 0, testSummary: null });
    expect(screen.getByText('未发现 Python 源文件', { exact: true })).toBeVisible();
    expect(view.container.querySelector('.studio-validation')).not.toHaveClass('is-pass');
  });

  it.each(['应用前验证', '应用后验证', '任务结果验证'])('shows the same conservative result for %s', title => {
    show({ ...pytest, cleanupConfirmed: false }, title);
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText('清理尚未确认', { exact: true })).toBeVisible();
  });

  it('preserves legacy Java and Node results without requiring new Python fields', () => {
    const view = show({ goal: 'test', exitCode: 0, cleanupConfirmed: true });
    expect(screen.getByText('通过', { exact: true })).toBeVisible();
    expect(view.container.querySelector('.studio-validation')).toHaveClass('is-pass');
  });
});

import { describe, expect, it } from 'vitest';
import { compareLogWindows, errorSummaryFromLog } from './runComparison';

describe('read log window comparison', () => {
  it('compares distinct text lines without claiming to compare ordering or counts', () => {
    expect(compareLogWindows('same\r\nremoved\nsame\n', 'added\nsame\nsame\n')).toEqual({
      added: ['added'], removed: ['removed'], addedCount: 1, removedCount: 1,
    });
    expect(compareLogWindows('', '')).toEqual({ added: [], removed: [], addedCount: 0, removedCount: 0 });
  });
  it('bounds displayed differences and reports their full counts', () => {
    const left = Array.from({ length: 50 }, (_, i) => `left-${i}`).join('\n');
    const right = Array.from({ length: 100 }, (_, i) => `right-${i}`).join('\n');
    const compared = compareLogWindows(left, right);
    expect(compared.added).toHaveLength(8);
    expect(compared.removed).toHaveLength(8);
    expect(compared).toMatchObject({ addedCount: 100, removedCount: 50 });
  });
  it('extracts a bounded rule-based error summary including Python exceptions', () => {
    const text = ['Traceback (most recent call last):', 'normal output', 'ValueError: invalid',
      '[ERROR] compile failed', `Exception: ${'a'.repeat(1000)}`].join('\n');
    const errors = errorSummaryFromLog(text).split('\n');
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe('ValueError: invalid');
    expect(errors.at(-1)).toHaveLength(240);
    expect(errorSummaryFromLog('hello\nall passed')).toBe('');
  });
});

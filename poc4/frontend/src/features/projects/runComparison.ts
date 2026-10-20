export function compareLogWindows(leftText: string, rightText: string) {
  const left = new Set(leftText.split(/\r?\n/).filter(Boolean));
  const right = new Set(rightText.split(/\r?\n/).filter(Boolean));
  const added = [...right].filter((line) => !left.has(line));
  const removed = [...left].filter((line) => !right.has(line));
  return { added: added.slice(0, 8), removed: removed.slice(0, 8), addedCount: added.length, removedCount: removed.length };
}

export function errorSummaryFromLog(text: string): string {
  const errors = text.split(/\r?\n/).filter((line) => /(?:\b(?:error|exception|traceback|fatal)\b|\w*(?:Error|Exception)\s*:|\[ERROR\])/i.test(line));
  return errors.slice(-3).map((line) => line.slice(0, 240)).join('\n');
}

export type RunErrorLocation = {
  path: string;
  line: number;
  column?: number;
  source: 'java' | 'python' | 'generic';
};

const pythonTraceback = /File\s+["']([^"']+)["']\s*,\s*line\s+(\d+)/i;
const javaStack = /(?:^|\s)(?:at\s+)?(?:[\w$]+\.)*[\w$]+\(([^():]+\.(?:java|kt)):(\d+)\)/i;
const genericPath = /(?:^|[\s(])((?:[A-Za-z]:)?[\\/]?(?:[\w.-]+[\\/])*[\w.-]+\.(?:java|py|kt|js|ts|tsx|jsx)):(\d+)(?::(\d+))?/i;
const mavenError = /^\s*(?:\[ERROR\]\s+)?(.+?\.java):\[(\d+),(\d+)\]/;

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function parseRunErrorLocations(logText: string): RunErrorLocation[] {
  const locations: RunErrorLocation[] = [];
  const seen = new Set<string>();
  const add = (location: RunErrorLocation) => {
    if (!Number.isSafeInteger(location.line) || location.line <= 0 ||
      (location.column !== undefined && (!Number.isSafeInteger(location.column) || location.column <= 0))) return;
    const normalized = { ...location, path: normalizePath(location.path) };
    const key = `${normalized.path}:${normalized.line}:${normalized.column ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      locations.push(normalized);
    }
  };
  for (const line of logText.split(/\r?\n/)) {
    const python = line.match(pythonTraceback);
    if (python) add({ path: python[1], line: Number(python[2]), source: 'python' });
    const java = line.match(javaStack);
    if (java) add({ path: java[1], line: Number(java[2]), source: 'java' });
    const generic = line.match(genericPath);
    if (generic) add({ path: generic[1], line: Number(generic[2]), column: generic[3] ? Number(generic[3]) : undefined, source: 'generic' });
    const maven = line.match(mavenError);
    if (maven) add({ path: maven[1].trim(), line: Number(maven[2]), column: Number(maven[3]), source: 'java' });
    if (locations.length >= 100) break;
  }
  return locations.slice(0, 100);
}

export function resolveRunErrorPath(location: RunErrorLocation, paths: readonly string[]): string | null {
  const target = normalizePath(location.path);
  const exact = paths.find((path) => normalizePath(path) === target);
  if (exact) return exact;
  const suffixMatches = paths.filter((path) => target.endsWith(`/${normalizePath(path)}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  // Qualified paths must match their suffix; basename guessing can open an unrelated file.
  if (target.includes('/')) return null;
  const basename = target.slice(target.lastIndexOf('/') + 1);
  const matches = paths.filter((path) => normalizePath(path).endsWith(`/${basename}`) || normalizePath(path) === basename);
  return matches.length === 1 ? matches[0] : null;
}

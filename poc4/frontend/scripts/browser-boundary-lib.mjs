const forbiddenDependencies = ['electron', 'electron-vite', 'electron-log', 'node-pty'];

const sourceRules = [
  ['electron-api', /window\.electronAPI/],
  ['electron-import', /(?:from\s+|import\s*)['"]electron(?:\/[^'"]*)?['"]/],
  ['node-pty', /['"]node-pty['"]/],
  ['windows-absolute-path', /[A-Za-z]:\\+(?:Users|DeepLearning|Projects)\\/],
  ['macos-absolute-path', /['"]\/Users\//],
];

export function findForbiddenDependencies(packageJson) {
  const production = Object.keys(packageJson.dependencies ?? {});
  return forbiddenDependencies.filter((name) => production.includes(name));
}

export function findForbiddenSource(file, source) {
  return sourceRules
    .filter(([, pattern]) => pattern.test(source))
    .map(([rule]) => ({ file, rule }));
}

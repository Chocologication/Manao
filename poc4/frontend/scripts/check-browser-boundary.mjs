import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findForbiddenContractNames,
  findForbiddenDependencies,
  findForbiddenDistributionStrings,
  findForbiddenSource,
  findForbiddenWorkbenchImports,
  findTerminalCssDistributionViolations,
  findTerminalCssSourceViolations,
} from './browser-boundary-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);
const distributionTextExtensions = new Set(['.html', '.js', '.css']);

async function listTextFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTextFiles(fullPath, extensions);
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return extensions.has(path.extname(entry.name)) ? [fullPath] : [];
  }));
  return nested.flat();
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dependencyViolations = findForbiddenDependencies(packageJson).map(
  (name) => ({ file: 'package.json', rule: `forbidden dependency: ${name}` })
);
const sourceFiles = await listTextFiles(path.join(root, 'src'), sourceExtensions);
const sourceViolations = (
  await Promise.all(sourceFiles.map(async (file) => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const source = await readFile(file, 'utf8');
    return [
      ...findForbiddenSource(relative, source),
      ...findForbiddenWorkbenchImports(relative, source),
      ...findForbiddenContractNames(relative, source),
      ...findTerminalCssSourceViolations(relative, source),
    ];
  }))
).flat();
let distributionViolations = [];
try {
  await stat(path.join(root, 'dist'));
  const distFiles = await listTextFiles(path.join(root, 'dist'), distributionTextExtensions);
  const distAssets = await Promise.all(distFiles.map(async (file) => {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      return { file: relative, source: await readFile(file, 'utf8') };
    }));
  const indexHtml = distAssets.find(({ file }) => file === 'dist/index.html')?.source;
  distributionViolations = [
    ...distAssets.flatMap(({ file, source }) => findForbiddenDistributionStrings(file, source)),
    ...(indexHtml === undefined
      ? []
      : findTerminalCssDistributionViolations(indexHtml, distAssets)),
  ];
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const violations = [...dependencyViolations, ...sourceViolations, ...distributionViolations];

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.file}: ${violation.rule}`);
  process.exitCode = 1;
} else {
  console.log('Browser boundary check passed.');
}

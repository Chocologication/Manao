import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findForbiddenContractNames,
  findForbiddenDependencies,
  findForbiddenSource,
  findForbiddenWorkbenchImports,
} from './browser-boundary-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return extensions.has(path.extname(entry.name)) ? [fullPath] : [];
  }));
  return nested.flat();
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dependencyViolations = findForbiddenDependencies(packageJson).map(
  (name) => ({ file: 'package.json', rule: `forbidden dependency: ${name}` })
);
const sourceFiles = await listSourceFiles(path.join(root, 'src'));
const sourceViolations = (
  await Promise.all(sourceFiles.map(async (file) => {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const source = await readFile(file, 'utf8');
    return [
      ...findForbiddenSource(relative, source),
      ...findForbiddenWorkbenchImports(relative, source),
      ...findForbiddenContractNames(relative, source),
    ];
  }))
).flat();
const violations = [...dependencyViolations, ...sourceViolations];

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.file}: ${violation.rule}`);
  process.exitCode = 1;
} else {
  console.log('Browser boundary check passed.');
}

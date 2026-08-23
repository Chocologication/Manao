import type { ProjectDirectoryPath, ProjectRelativePath } from '../../contracts/file';
import { parseProjectRelativePath } from './pathPolicy';

const ENTRY_NAME_REQUIRED = 'Entry name required';

export function parseEntryBasename(value: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(ENTRY_NAME_REQUIRED);
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(ENTRY_NAME_REQUIRED);
  }
  if (value === '.' || value === '..') {
    throw new Error(ENTRY_NAME_REQUIRED);
  }
  return value;
}

export function joinProjectPath(
  parent: ProjectDirectoryPath,
  basename: string,
): ProjectRelativePath {
  const name = parseEntryBasename(basename);
  return parseProjectRelativePath(parent === '' ? name : `${parent}/${name}`);
}

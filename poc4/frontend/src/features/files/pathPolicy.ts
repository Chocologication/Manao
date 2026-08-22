import type { ProjectDirectoryPath, ProjectRelativePath } from '../../contracts/file';

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;
const PROJECT_RELATIVE_PATH_REQUIRED = 'Project-relative path required';

export function parseProjectRelativePath(value: string): ProjectRelativePath;
export function parseProjectRelativePath(
  value: string,
  options?: { allowRoot?: boolean },
): ProjectDirectoryPath;
export function parseProjectRelativePath(
  value: string,
  options?: { allowRoot?: boolean },
): ProjectDirectoryPath {
  if (typeof value !== 'string') {
    throw new Error(PROJECT_RELATIVE_PATH_REQUIRED);
  }
  if (value === '') {
    if (options?.allowRoot) {
      return '';
    }
    throw new Error(PROJECT_RELATIVE_PATH_REQUIRED);
  }
  // Keep percent text literal; transport encoding is URLSearchParams' job.
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    WINDOWS_DRIVE_PREFIX.test(value)
  ) {
    throw new Error(PROJECT_RELATIVE_PATH_REQUIRED);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(PROJECT_RELATIVE_PATH_REQUIRED);
    }
  }
  return value as ProjectRelativePath;
}

export function parseProjectDirectoryPath(value: string): ProjectDirectoryPath {
  return parseProjectRelativePath(value, { allowRoot: true });
}

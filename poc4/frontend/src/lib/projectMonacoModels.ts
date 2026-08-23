import * as monaco from 'monaco-editor';
import type { ProjectRelativePath } from '../contracts/file';
import { parseProjectRelativePath } from '../features/files/pathPolicy';

const SCHEME = 'poc4';
const AUTHORITY = 'workspace';

function isProjectWorkspaceUri(uri: monaco.Uri): boolean {
  return uri.scheme === SCHEME && uri.authority === AUTHORITY;
}

function projectPathPrefix(projectId: string): string {
  return `/${encodeURIComponent(projectId)}/`;
}

export function toProjectModelUri(projectId: string, path: ProjectRelativePath): monaco.Uri {
  const relative = parseProjectRelativePath(path);
  return monaco.Uri.from({
    scheme: SCHEME,
    authority: AUTHORITY,
    path: `${projectPathPrefix(projectId)}${relative}`,
  });
}

export function disposeProjectModel(projectId: string, path: ProjectRelativePath): void {
  monaco.editor.getModel(toProjectModelUri(projectId, path))?.dispose();
}

export function disposeProjectModels(projectId: string): void {
  const prefix = projectPathPrefix(projectId);
  for (const model of monaco.editor.getModels()) {
    if (isProjectWorkspaceUri(model.uri) && model.uri.path.startsWith(prefix)) {
      model.dispose();
    }
  }
}

export function disposeAllProjectModels(): void {
  for (const model of monaco.editor.getModels()) {
    if (isProjectWorkspaceUri(model.uri)) {
      model.dispose();
    }
  }
}

function relativeFromProjectUri(projectId: string, uri: monaco.Uri): string | null {
  if (!isProjectWorkspaceUri(uri)) {
    return null;
  }
  const prefix = projectPathPrefix(projectId);
  if (!uri.path.startsWith(prefix)) {
    return null;
  }
  return uri.path.slice(prefix.length);
}

function isExactOrDescendant(parent: ProjectRelativePath, relative: string): boolean {
  return relative === parent || relative.startsWith(`${parent}/`);
}

export function disposeDescendantProjectModels(projectId: string, path: ProjectRelativePath): void {
  const target = parseProjectRelativePath(path);
  for (const model of [...monaco.editor.getModels()]) {
    const relative = relativeFromProjectUri(projectId, model.uri);
    if (relative !== null && isExactOrDescendant(target, relative)) {
      model.dispose();
    }
  }
}

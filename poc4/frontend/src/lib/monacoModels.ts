import * as monaco from 'monaco-editor';

const windowsDrive = /^[A-Za-z]:[\\/]/;

export function toModelUri(path: string): monaco.Uri {
  const normalized = path.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    windowsDrive.test(path) ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Project-relative path required');
  }
  return monaco.Uri.from({ scheme: 'poc4', authority: 'workspace', path: `/${normalized}` });
}

export function disposeModel(path: string): void {
  monaco.editor.getModel(toModelUri(path))?.dispose();
}

export function disposeAllPoc4Models(): void {
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme === 'poc4') model.dispose();
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'shell',
  css: 'css',
  csv: 'plaintext',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  scss: 'scss',
  sh: 'shell',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

export function languageForFile(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (name === '.gitignore') {
    return 'ignore';
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return 'plaintext';
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1)] ?? 'plaintext';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

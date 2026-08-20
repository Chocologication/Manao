import type { LucideIcon } from 'lucide-react';
import {
  Braces,
  Code,
  Database,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Settings,
  Terminal,
} from 'lucide-react';

const fileIconMap: Record<string, LucideIcon> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  json: FileJson,
  yaml: Settings,
  yml: Settings,
  toml: Settings,
  html: Code,
  css: Braces,
  scss: Braces,
  less: Braces,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  bmp: FileImage,
  ico: FileImage,
  md: FileText,
  txt: FileText,
  pdf: FileText,
  sh: Terminal,
  bash: Terminal,
  zsh: Terminal,
  sql: Database,
  db: Database,
  sqlite: Database,
  ttf: FileType,
  otf: FileType,
  woff: FileType,
  woff2: FileType,
  default: File,
};

const specialFileIconMap: Record<string, LucideIcon> = {
  'package.json': FileJson,
  'tsconfig.json': Settings,
  '.gitignore': Settings,
  '.env': Settings,
  '.env.local': Settings,
  dockerfile: Terminal,
  'docker-compose.yml': Settings,
  'readme.md': FileText,
};

export function getFileIcon(name: string, isDirectory: boolean, isExpanded = false): LucideIcon {
  if (isDirectory) {
    return isExpanded ? FolderOpen : Folder;
  }

  const lowerName = name.toLowerCase();

  if (specialFileIconMap[lowerName]) {
    return specialFileIconMap[lowerName];
  }

  const ext = name.split('.').pop()?.toLowerCase() || '';
  return fileIconMap[ext] || fileIconMap.default;
}

export function getFileIconColor(name: string, isDirectory: boolean): string {
  if (isDirectory) {
    return 'text-amber-500';
  }

  const ext = name.split('.').pop()?.toLowerCase() || '';

  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'text-blue-500';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'text-yellow-500';
    case 'json':
      return 'text-yellow-600';
    case 'html':
      return 'text-orange-500';
    case 'css':
    case 'scss':
    case 'less':
      return 'text-pink-500';
    case 'md':
      return 'text-sky-500';
    case 'pdf':
      return 'text-red-500';
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return 'text-green-500';
    default:
      return 'text-muted-foreground';
  }
}

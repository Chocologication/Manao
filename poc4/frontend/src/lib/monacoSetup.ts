import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

monaco.editor.defineTheme('manao-lab', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '82978B' },
    { token: 'keyword', foreground: '65B9FF' },
    { token: 'string', foreground: 'D8FF72' },
    { token: 'number', foreground: 'F1BD68' },
  ],
  colors: {
    'editor.background': '#0B1110', 'editor.foreground': '#E0EBE4',
    'editorLineNumber.foreground': '#657D6D', 'editorLineNumber.activeForeground': '#D8FF72',
    'editor.lineHighlightBackground': '#17211F', 'editor.selectionBackground': '#304B3B',
    'editorCursor.foreground': '#D8FF72', 'editorWidget.background': '#17211F',
  },
});

monaco.editor.defineTheme('manao-graphite', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: 'A5AFB8' },
    { token: 'keyword', foreground: 'A9D6FF' },
    { token: 'string', foreground: '7EDBAE' },
    { token: 'number', foreground: 'EEC77A' },
  ],
  colors: {
    'editor.background': '#111315', 'editor.foreground': '#EDF0F2',
    'editorLineNumber.foreground': '#85909A', 'editorLineNumber.activeForeground': '#A9D6FF',
    'editor.lineHighlightBackground': '#202428', 'editor.selectionBackground': '#304354',
    'editorCursor.foreground': '#A9D6FF', 'editorWidget.background': '#202428',
  },
});

monaco.editor.defineTheme('manao-light', {
  base: 'vs', inherit: true,
  rules: [
    { token: 'comment', foreground: '5E6D77' },
    { token: 'keyword', foreground: '2466A4' },
    { token: 'string', foreground: '356619' },
    { token: 'number', foreground: '946214' },
  ],
  colors: {
    'editor.background': '#F7F9FA', 'editor.foreground': '#202A32',
    'editorLineNumber.foreground': '#5E6D77', 'editorLineNumber.activeForeground': '#356619',
    'editor.lineHighlightBackground': '#ECF1F4', 'editor.selectionBackground': '#D7E8EE',
    'editorCursor.foreground': '#356619', 'editorWidget.background': '#FFFFFF',
  },
});

const monacoGlobal = globalThis as typeof globalThis & { monaco?: typeof monaco };
monacoGlobal.monaco = monaco;

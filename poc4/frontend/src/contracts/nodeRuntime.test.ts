import { describe, expect, it } from 'vitest';
import { parseRunSummary, runRuntimeLabel } from './run';
import { RUNTIME_TEMPLATE_META } from './project';
import { cloneRunPolicyForTemplate } from '../mocks/runFixtures';
import { NODE_TEMPLATE_FILES } from '../mocks/nodeTemplates';
import { ensureWorkspace, getMockFile, getWorkspaceRevision, listDirectoryEntries } from '../mocks/fileFixtures';

describe('Node.js runtime contract', () => {
  for (const id of ['node-javascript-console', 'node-javascript-web', 'node-typescript-console', 'node-typescript-web'] as const) {
    it(`${id} preserves its language, policy and complete mock workspace`, () => {
      const policy = cloneRunPolicyForTemplate(id);
      const run = parseRunSummary({ id: 'node-run', state: 'STARTING', requestedWorkspaceRevision: '1', policy,
        createdAt: '2026-11-04T00:00:00Z', startedAt: null, finishedAt: null, terminationReason: null,
        exitCode: null, logTruncated: false, logEvictedBytes: 0, lastLogSeq: null });
      expect(run.policy.runtime).toEqual({ language: id.includes('typescript') ? 'typescript' : 'javascript', nodeMajor: 24, packageManager: 'pnpm', pnpmMajor: 10 });
      expect(runRuntimeLabel(run.policy.runtime)).toContain('Node.js 24');
      expect(run.policy.command).toBe('pnpm start');
      expect(RUNTIME_TEMPLATE_META[id].defaultTargetPort).toBe(3000);
      ensureWorkspace(id, id);
      expect(getWorkspaceRevision(id)).toBeTruthy();
      expect(getMockFile(id, 'package.json')?.textContent).toBe(NODE_TEMPLATE_FILES[id]['package.json']);
      expect(getMockFile(id, 'package.json')?.language).toBe('json');
      const extension = id.includes('typescript') ? 'ts' : 'js';
      expect(getMockFile(id, `src/main.${extension}`)?.language).toBe(id.includes('typescript') ? 'typescript' : 'javascript');
      expect(listDirectoryEntries(id, '')?.some(file => file.path === 'src')).toBe(true);
      expect(getMockFile(id, 'pom.xml')).toBeNull();
      const mixed = { ...run, policy: { ...policy, runtime: { ...policy.runtime, javaMajor: 17 } } };
      expect(() => parseRunSummary(mixed)).toThrow();
      expect(() => parseRunSummary({ ...run, policy: { ...policy, runtime: { ...policy.runtime, nodeMajor: 22 } } })).toThrow();
    });
  }
});

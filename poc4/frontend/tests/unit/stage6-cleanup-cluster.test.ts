import { afterEach, describe, expect, it } from 'vitest';
import {
  assertMutableProject,
  createClusterClient,
  leftoverInitializerManifest,
} from '../support/stage6-cleanup/cluster.ts';

const IMAGE = 'busybox@sha256:' + 'a'.repeat(64);
const PROJECT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('stage6 leftover initializer fixture', () => {
  const previousImage = process.env.MANAO_WORKSPACE_INITIALIZER_IMAGE;

  afterEach(() => {
    if (previousImage === undefined) {
      delete process.env.MANAO_WORKSPACE_INITIALIZER_IMAGE;
    } else {
      process.env.MANAO_WORKSPACE_INITIALIZER_IMAGE = previousImage;
    }
  });

  it('refuses to describe or mutate protected diagnostics', () => {
    expect(() => assertMutableProject('083b8efd-9f57-4cb4-aa6f-646b37bd6d57')).toThrow('PROTECTED_DIAGNOSTIC');
    expect(() => leftoverInitializerManifest('083b8efd-9f57-4cb4-aa6f-646b37bd6d57', 'manao-stage6-test', IMAGE))
      .toThrow('PROTECTED_DIAGNOSTIC');
    expect(() => leftoverInitializerManifest('6c6378b2-1111-2222-3333-444444444444', 'manao-stage6-test', IMAGE))
      .toThrow('PROTECTED_DIAGNOSTIC');
  });

  it('builds a factory-named leftover pod with project resource labels', () => {
    const yaml = leftoverInitializerManifest(PROJECT, 'manao-stage6-test', IMAGE);
    expect(yaml).toContain('name: manao-ws-init-' + PROJECT);
    expect(yaml).toContain('app.kubernetes.io/managed-by: manao-poc4-backend');
    expect(yaml).toContain('manao.poc4/project-id: "' + PROJECT + '"');
    expect(yaml).toContain('stage6-test: "true"');
    expect(yaml).toContain('manao.poc4/component: initializer');
    expect(yaml).toContain('image: ' + IMAGE);
    expect(yaml).not.toContain('083b8efd');
  });

  it('creates leftover initializer only after verifying the registered PVC', () => {
    process.env.MANAO_WORKSPACE_INITIALIZER_IMAGE = IMAGE;
    const calls: { args: string[]; input?: string }[] = [];
    const client = createClusterClient({
      kubeconfig: 'C:\\tmp\\kubeconfig',
      namespace: 'manao-stage6-test',
      run(args, input) {
        calls.push({ args, input });
        if (args.includes('pvc')) {
          return JSON.stringify({
            items: [{ metadata: { name: 'manao-pvc-' + PROJECT, resourceVersion: '9', labels: {} } }],
          });
        }
        if (args.includes('apply')) {
          return 'pod/manao-ws-init-' + PROJECT + ' created';
        }
        return JSON.stringify({ items: [] });
      },
    });
    const created = client.createLeftoverInitializer(PROJECT);
    expect(created.name).toBe('manao-ws-init-' + PROJECT);
    expect(created.image).toBe(IMAGE);
    const apply = calls.find((call) => call.args.includes('apply'));
    expect(apply?.input).toContain('manao.poc4/component: initializer');
    expect(apply?.input).toContain('manao-ws-init-' + PROJECT);
    expect(calls.some((call) => call.args.includes('jobs'))).toBe(true);
  });

  it('records an empty job list only after a successful inventory', () => {
    const client = createClusterClient({
      kubeconfig: 'C:\\tmp\\kubeconfig',
      namespace: 'manao-stage6-test',
      run() {
        return JSON.stringify({ items: [] });
      },
    });
    expect(client.snapshot(PROJECT).jobs).toEqual([]);
  });

  it('does not treat a forbidden or timed-out job list as empty', () => {
    const forbidden = createClusterClient({
      kubeconfig: 'C:\\tmp\\kubeconfig',
      namespace: 'manao-stage6-test',
      run(args) {
        if (args.includes('jobs')) {
          throw new Error('Error from server (Forbidden): jobs.batch is forbidden');
        }
        return JSON.stringify({ items: [] });
      },
    });
    const forbiddenSnap = forbidden.snapshot(PROJECT);
    expect(forbiddenSnap.jobs).toBeNull();
    expect(forbiddenSnap.jobs).not.toEqual([]);

    const timedOut = createClusterClient({
      kubeconfig: 'C:\\tmp\\kubeconfig',
      namespace: 'manao-stage6-test',
      run(args) {
        if (args.includes('jobs')) {
          throw new Error('spawnSync kubectl ETIMEDOUT');
        }
        return JSON.stringify({ items: [] });
      },
    });
    expect(timedOut.snapshot(PROJECT).jobs).toBeNull();

    const status = createClusterClient({
      kubeconfig: 'C:\\tmp\\kubeconfig',
      namespace: 'manao-stage6-test',
      run(args) {
        if (args.includes('jobs')) {
          return JSON.stringify({ kind: 'Status', status: 'Failure', code: 403, message: 'forbidden' });
        }
        return JSON.stringify({ items: [] });
      },
    });
    expect(status.snapshot(PROJECT).jobs).toBeNull();
  });
});

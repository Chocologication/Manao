import { execFileSync } from 'node:child_process';

export const PROTECTED_PROJECT_PREFIXES = [
  '083b8efd-9f57-4cb4-aa6f-646b37bd6d57',
  '6c6378b2',
] as const;

const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAMESPACE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type KubectlRunner = (args: string[], input?: string) => string;

export type ClusterResource = {
  name: string;
  resourceVersion: string;
  phase?: string;
  labels: Record<string, string>;
};

export type ClusterSnapshot = {
  pods: ClusterResource[];
  pvcs: ClusterResource[];
  services: ClusterResource[];
  /**
   * Successful Job inventory. `null` means Forbidden, timeout, or any other
   * unread list and must not be treated as empty.
   */
  jobs: ClusterResource[] | null;
};

export type ClusterClientOptions = {
  kubectl?: string;
  kubeconfig?: string;
  namespace?: string;
  run?: KubectlRunner;
};

export function assertMutableProject(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) {
    throw new Error('INVALID_PROJECT_ID');
  }
  const lowered = projectId.toLowerCase();
  if (PROTECTED_PROJECT_PREFIXES.some((prefix) => lowered.startsWith(prefix.toLowerCase()))) {
    throw new Error('PROTECTED_DIAGNOSTIC');
  }
}

export function leftoverInitializerManifest(projectId: string, namespace: string, image: string): string {
  assertMutableProject(projectId);
  if (!NAMESPACE.test(namespace)) {
    throw new Error('INVALID_NAMESPACE');
  }
  if (!IMAGE_DIGEST.test(image)) {
    throw new Error('IMAGE_DIGEST_REQUIRED');
  }
  return [
    'apiVersion: v1',
    'kind: Pod',
    'metadata:',
    '  name: manao-ws-init-' + projectId,
    '  namespace: ' + namespace,
    '  labels:',
    '    app.kubernetes.io/managed-by: manao-poc4-backend',
    '    manao.poc4/project-id: "' + projectId + '"',
    '    stage6-test: "true"',
    '    manao.poc4/component: initializer',
    'spec:',
    '  restartPolicy: Never',
    '  automountServiceAccountToken: false',
    '  activeDeadlineSeconds: 600',
    '  containers:',
    '    - name: leftover',
    '      image: ' + image,
    '      command: ["/bin/sh", "-ec", "true"]',
    '      securityContext:',
    '        allowPrivilegeEscalation: false',
    '        runAsNonRoot: true',
    '        runAsUser: 10001',
    '        runAsGroup: 10001',
    '',
  ].join('\n');
}

export function createClusterClient(options: ClusterClientOptions = {}) {
  const kubectl = options.kubectl ?? process.env.MANAO_KUBECTL ?? 'kubectl';
  const kubeconfig = options.kubeconfig ?? process.env.KUBECONFIG;
  const namespace = options.namespace ?? process.env.MANAO_K8S_NAMESPACE;
  if (kubeconfig === undefined || kubeconfig === '') {
    throw new Error('KUBECONFIG_REQUIRED');
  }
  if (namespace === undefined || !NAMESPACE.test(namespace)) {
    throw new Error('NAMESPACE_REQUIRED');
  }
  const configPath: string = kubeconfig;
  const ns: string = namespace;
  const run: KubectlRunner = options.run ?? ((args, input) => execFileSync(kubectl, args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    env: { ...process.env, KUBECONFIG: configPath },
  }));

  function kc(args: string[], input?: string): string {
    return run(['--kubeconfig', configPath, '-n', ns, ...args], input);
  }

  function parseList(rawJson: string): ClusterResource[] {
    const raw = JSON.parse(rawJson) as {
      items?: Array<{
        metadata?: { name?: string; resourceVersion?: string; labels?: Record<string, string> };
        status?: { phase?: string };
      }>;
    };
    return (raw.items ?? []).map((item) => ({
      name: item.metadata?.name ?? '',
      resourceVersion: item.metadata?.resourceVersion ?? '',
      phase: item.status?.phase,
      labels: item.metadata?.labels ?? {},
    }));
  }

  function listJobs(selector: string): ClusterResource[] | null {
    try {
      const rawJson = kc(['get', 'jobs', '-l', selector, '-o', 'json']);
      const raw = JSON.parse(rawJson) as { kind?: string; status?: string; code?: number };
      if (raw.kind === 'Status' || raw.status === 'Failure' || (typeof raw.code === 'number' && raw.code >= 400)) {
        return null;
      }
      return parseList(rawJson);
    } catch {
      return null;
    }
  }

  function snapshot(projectId: string): ClusterSnapshot {
    assertMutableProject(projectId);
    const selector = 'manao.poc4/project-id=' + projectId;
    return {
      pods: parseList(kc(['get', 'pods', '-l', selector, '-o', 'json'])),
      pvcs: parseList(kc(['get', 'pvc', '-l', selector, '-o', 'json'])),
      services: parseList(kc(['get', 'svc', '-l', selector, '-o', 'json'])),
      jobs: listJobs(selector),
    };
  }

  function resolveInitializerImage(): string {
    const fromEnv = process.env.MANAO_WORKSPACE_INITIALIZER_IMAGE;
    if (fromEnv !== undefined && IMAGE_DIGEST.test(fromEnv)) {
      return fromEnv;
    }
    const raw = JSON.parse(kc(['get', 'pod', 'manao-ws-init-083b8efd-9f57-4cb4-aa6f-646b37bd6d57', '-o', 'json'])) as {
      spec?: { initContainers?: Array<{ image?: string }>; containers?: Array<{ image?: string }> };
    };
    const image = raw.spec?.initContainers?.[0]?.image ?? raw.spec?.containers?.[0]?.image;
    if (image === undefined || !IMAGE_DIGEST.test(image)) {
      throw new Error('IMAGE_DIGEST_REQUIRED');
    }
    return image;
  }

  return {
    namespace: ns,
    snapshot,
    leftoverExists(projectId: string): boolean {
      return snapshot(projectId).pods.some((pod) => pod.name === 'manao-ws-init-' + projectId);
    },
    createLeftoverInitializer(projectId: string): { name: string; image: string } {
      assertMutableProject(projectId);
      const current = snapshot(projectId);
      if (!current.pvcs.some((pvc) => pvc.name === 'manao-pvc-' + projectId)) {
        throw new Error('PVC_NOT_FOUND');
      }
      const image = resolveInitializerImage();
      const yaml = leftoverInitializerManifest(projectId, ns, image);
      kc(['apply', '-f', '-'], yaml);
      return { name: 'manao-ws-init-' + projectId, image };
    },
  };
}

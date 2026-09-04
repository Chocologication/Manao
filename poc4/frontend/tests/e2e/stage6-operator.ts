import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type FaultAction = 'backend-restart' | 'tunnel-loss' | 'bridge-loss';

export type FaultEvidence = {
  operator: string;
  action: FaultAction;
  startedAt: string;
  endedAt: string;
  targetHash: string;
  result: 'injected';
  proof: Record<string, unknown>;
};

const OPERATOR_ID = process.env.STAGE6_OPERATOR_ID ?? 'stage6-operator';
const NAMESPACE = process.env.STAGE6_NAMESPACE ?? 'manao-stage6-test';
const KUBECONFIG = process.env.STAGE6_OPERATOR_KUBECONFIG ?? '';
const EVIDENCE_PATH = process.env.STAGE6_FAULT_EVIDENCE ?? '';

export function loadFaultEvidence(action: FaultAction): FaultEvidence | null {
  if (!EVIDENCE_PATH || !existsSync(EVIDENCE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as FaultEvidence;
  return parsed.action === action ? parsed : null;
}

export function assertOperatorEvidence(evidence: FaultEvidence, action: FaultAction): void {
  if (evidence.operator !== OPERATOR_ID) {
    throw new Error('fault evidence operator identity must be ' + OPERATOR_ID);
  }
  if (evidence.action !== action) {
    throw new Error('fault evidence action must be ' + action);
  }
  if (evidence.result !== 'injected') {
    throw new Error('fault evidence result must be injected');
  }
  if (!/^[0-9a-f]{64}$/.test(evidence.targetHash)) {
    throw new Error('fault evidence targetHash must be a sha256 hex digest');
  }
  if (!evidence.startedAt || !evidence.endedAt || evidence.endedAt < evidence.startedAt) {
    throw new Error('fault evidence timestamps are missing or inverted');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeEvidence(evidence: FaultEvidence): FaultEvidence {
  if (EVIDENCE_PATH) {
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2), 'utf8');
  }
  return evidence;
}

function kubectl(args: string[]): string {
  if (!KUBECONFIG) {
    throw new Error('STAGE6_OPERATOR_KUBECONFIG is required to inject cluster faults');
  }
  return execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, '-n', NAMESPACE, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

export function injectBridgeLoss(projectId: string): FaultEvidence {
  const startedAt = new Date().toISOString();
  const podName = 'manao-ws-' + projectId;
  const raw = kubectl(['get', 'pod', podName, '-o', 'json']);
  const pod = JSON.parse(raw) as { metadata?: { labels?: Record<string, string> } };
  const labels = pod.metadata?.labels ?? {};
  if (labels['stage6-test'] !== 'true') {
    throw new Error('refusing to delete a pod without stage6-test=true');
  }
  if (labels['manao.poc4/component'] !== 'workspace') {
    throw new Error('refusing to delete a non-workspace pod');
  }
  kubectl(['delete', 'pod', podName, '--wait=false']);
  const endedAt = new Date().toISOString();
  return writeEvidence({
    operator: OPERATOR_ID,
    action: 'bridge-loss',
    startedAt,
    endedAt,
    targetHash: sha256('pod/' + podName),
    result: 'injected',
    proof: { label: 'stage6-test=true', deleted: true, component: 'workspace' },
  });
}

export function injectCommandFault(action: 'backend-restart' | 'tunnel-loss', command: string): FaultEvidence {
  const startedAt = new Date().toISOString();
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  const endedAt = new Date().toISOString();
  return writeEvidence({
    operator: OPERATOR_ID,
    action,
    startedAt,
    endedAt,
    targetHash: sha256(action),
    result: 'injected',
    proof: { commandRan: true },
  });
}

export function resolveFaultEvidence(action: FaultAction, projectId: string): FaultEvidence {
  if (action === 'bridge-loss' && KUBECONFIG) {
    return injectBridgeLoss(projectId);
  }
  if (action === 'backend-restart' && process.env.STAGE6_BACKEND_RESTART_CMD) {
    return injectCommandFault('backend-restart', process.env.STAGE6_BACKEND_RESTART_CMD);
  }
  if (action === 'tunnel-loss' && process.env.STAGE6_TUNNEL_STOP_CMD) {
    return injectCommandFault('tunnel-loss', process.env.STAGE6_TUNNEL_STOP_CMD);
  }
  const loaded = loadFaultEvidence(action);
  if (loaded == null) {
    throw new Error(
      'STAGE6_FAULT=' + action + ' requires operator injection: set STAGE6_OPERATOR_KUBECONFIG '
      + '(bridge-loss), STAGE6_BACKEND_RESTART_CMD, STAGE6_TUNNEL_STOP_CMD, or STAGE6_FAULT_EVIDENCE',
    );
  }
  return loaded;
}

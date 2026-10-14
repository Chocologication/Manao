/**
 * Static manifest checks for the AI stage-one release preparation
 * (node --test; run via pnpm test:ai-stage1:scripts).
 *
 * No cluster is involved: the release YAML is parsed with a minimal indentation
 * scan and the pod security envelope is asserted against the reviewed contract.
 * The runtime half — a real first write to /work/agent under UID 1000 on the real
 * mounts — stays an explicit deploy-time verification item (deploy README 5) and
 * is only listed here, never claimed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MANIFEST = fileURLToPath(new URL('../../deploy/ai-stage1/pi-worker.yaml', import.meta.url));

/** The pod-level securityContext block of the worker Deployment (2-space spec nesting). */
function podSecurityContext(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'securityContext:');
  assert.ok(start >= 0, 'the Deployment template must declare a pod securityContext');
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !lines[i].startsWith('        ')) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

function value(block, key) {
  const match = new RegExp(`^\\s+${key}:\\s*(\\S+)\\s*$`, 'm').exec(block);
  return match === null ? null : match[1];
}

test('the worker pod security context gives the emptyDirs group-write for UID 1000', () => {
  const block = podSecurityContext(readFileSync(MANIFEST, 'utf8'));
  assert.equal(value(block, 'runAsNonRoot'), 'true');
  assert.equal(value(block, 'runAsUser'), '1000');
  const runAsGroup = value(block, 'runAsGroup');
  const fsGroup = value(block, 'fsGroup');
  // Review fix I5: without fsGroup the fresh emptyDir overlays the image directory's
  // ownership and the first write to /work/agent or /work/sessions can fail EACCES.
  assert.equal(fsGroup, '1000', 'fsGroup must equal the run group so the emptyDirs are group-writable');
  assert.equal(runAsGroup, '1000');
  assert.equal(fsGroup, runAsGroup, 'fsGroup must match runAsGroup');
});

test('the worker never automounts a ServiceAccount token', () => {
  const yaml = readFileSync(MANIFEST, 'utf8');
  assert.match(yaml, /^      automountServiceAccountToken: false$/m);
});

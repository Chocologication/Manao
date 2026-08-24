import { MAX_LOG_CHUNK_UTF8_BYTES } from '../contracts/log';
import type { RunPolicy } from '../contracts/run';

const utf8 = new TextEncoder();

export const SEED_LOG_MARKER = 'ensoai-stage4-seed-log';
export const SEED_LOG_TEXT = `${SEED_LOG_MARKER}\n`;
export const GAP_DUP_MARKER = 'ensoai-stage4-gap-dup';
export const GAP_DUP_TEXT = `${GAP_DUP_MARKER}\n`;
export const GAP_SKIPPED_MARKER = 'ensoai-stage4-gap-skipped';
export const GAP_SKIPPED_TEXT = `${GAP_SKIPPED_MARKER}\n`;
export const GAP_VISIBLE_MARKER = 'ensoai-stage4-gap-visible';
export const GAP_VISIBLE_TEXT = `${GAP_VISIBLE_MARKER}\n`;
export const PERSISTED_OFFLINE_MARKER = 'ensoai-stage4-persisted-offline';
export const PERSISTED_OFFLINE_TEXT = `${PERSISTED_OFFLINE_MARKER}\n`;
export const RECONNECT_LIVE_MARKER = 'ensoai-stage4-reconnect-live';
export const RECONNECT_LIVE_TEXT = `${RECONNECT_LIVE_MARKER}\n`;

export const POC4_RUN_POLICY: RunPolicy = {
  command: 'mvn clean test',
  runtime: { javaMajor: 17, mavenMajor: 3 },
  timeoutSeconds: 1800,
  resources: {
    requests: {
      cpuMillis: 2000,
      memoryBytes: 2_147_483_648,
      ephemeralStorageBytes: 1_073_741_824,
    },
    limits: {
      cpuMillis: 4000,
      memoryBytes: 4_294_967_296,
      ephemeralStorageBytes: 2_147_483_648,
    },
  },
};

Object.freeze(POC4_RUN_POLICY);
Object.freeze(POC4_RUN_POLICY.runtime);
Object.freeze(POC4_RUN_POLICY.resources);
Object.freeze(POC4_RUN_POLICY.resources.requests);
Object.freeze(POC4_RUN_POLICY.resources.limits);

export const MAX_SIZE_LOG_CHUNK_TEXT = 'a'.repeat(MAX_LOG_CHUNK_UTF8_BYTES);

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

export function clonePoc4RunPolicy(): RunPolicy {
  return {
    command: 'mvn clean test',
    runtime: { javaMajor: 17, mavenMajor: 3 },
    timeoutSeconds: POC4_RUN_POLICY.timeoutSeconds,
    resources: {
      requests: { ...POC4_RUN_POLICY.resources.requests },
      limits: { ...POC4_RUN_POLICY.resources.limits },
    },
  };
}

import { MAX_LOG_CHUNK_UTF8_BYTES } from '../contracts/log';
import type { RunPolicy } from '../contracts/run';

const utf8 = new TextEncoder();

export const SEED_LOG_MARKER = 'ensoai-stage4-seed-log';
export const SEED_LOG_TEXT = `${SEED_LOG_MARKER}\n`;

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

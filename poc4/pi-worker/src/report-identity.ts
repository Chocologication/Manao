/**
 * The terminal report identity (repair design 2026-10-25, protocol supplement). The
 * reportId and the canonical content digest are lowercase SHA-256 over the UTF-8 compact
 * JSON array of the fixed fields: raw Unicode characters, unescaped slashes and preserved
 * nulls — exactly what `JSON.stringify` produces for an array, so the Java backend
 * (Jackson) and this worker compute byte-identical identities. The pinned cross-language
 * vectors live in `test/terminal-delivery.test.ts` and in the backend's
 * `AgentTaskStoreTest.terminalIdentityMatchesThePinnedCrossLanguageVectors`.
 */

import { createHash } from "node:crypto";

export type TerminalState = "COMPLETED" | "FAILED";
export type TerminalDisposition = "RECORDED" | "SETTLED" | "CLOSING";

/** The worker's terminal execution report; the backend recomputes and verifies reportId. */
export interface TerminalReport {
  protocolVersion: 1;
  reportId: string;
  state: TerminalState;
  summary: string;
  failureCode: string | null;
}

/** The durable backend decision for one terminal report; 200 means it is committed. */
export interface TerminalAck {
  reportId: string;
  reportSha256: string;
  disposition: TerminalDisposition;
}

/** The stable per-execution report identity: SHA-256 over [1, taskId, epoch, requestSha256, "terminal"]. */
export function terminalReportId(taskId: string, epoch: number, requestSha256: string): string {
  return sha256Hex(JSON.stringify([1, taskId, epoch, requestSha256, "terminal"]));
}

/** The canonical content digest: SHA-256 over [1, reportId, state, summary, failureCode]. */
export function terminalContentSha256(
  reportId: string,
  state: TerminalState,
  summary: string,
  failureCode: string | null,
): string {
  return sha256Hex(JSON.stringify([1, reportId, state, summary, failureCode]));
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf-8")).digest("hex");
}

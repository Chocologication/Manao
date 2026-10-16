type ToolResult = { toolCallId: string; toolName: string; data: Record<string, unknown> };
type DetailResponse = { status(): number; json(): Promise<unknown> };

/** A detail404 is only unavailable evidence; independent ledger collection decides absence. */
export async function collectToolResults(ids: string[], read: (id: string) => Promise<DetailResponse>) {
  const results: ToolResult[] = [], missingIds: string[] = [];
  for (const id of new Set(ids)) {
    const response = await read(id);
    if (response.status() === 404) { missingIds.push(id); continue; }
    if (response.status() !== 200) throw new Error('TOOL_DETAIL_REQUEST_FAILED');
    const raw = await response.json();
    if (raw === null || typeof raw !== 'object') throw new Error('TOOL_DETAIL_INVALID');
    const row = raw as Record<string, unknown>;
    if (row.toolCallId !== id || !['application', 'app_http_get', 'build'].includes(String(row.toolName))
      || row.data === null || typeof row.data !== 'object' || Array.isArray(row.data)) throw new Error('TOOL_DETAIL_INVALID');
    results.push(row as ToolResult);
  }
  return { results, missingIds };
}

export function verifyMissingToolResults(missingIds: string[], durableIds: unknown): void {
  if (!Array.isArray(durableIds) || !durableIds.every((id) => typeof id === 'string')
    || missingIds.some((id) => durableIds.includes(id))) throw new Error('MISSING_TOOL_DETAIL_HAS_DURABLE_ROW');
}

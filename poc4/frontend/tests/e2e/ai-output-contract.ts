export function validateAiOutputEnvironment(env: Record<string, string | undefined>): { baseURL: string; projectId: string } {
  const required = ['MANAO_AI_ACCEPTANCE_BASE_URL', 'MANAO_AI_ACCEPTANCE_PROJECT_ID', 'MANAO_AI_ACCEPTANCE_USERNAME', 'MANAO_AI_ACCEPTANCE_PASSWORD'];
  const missing = required.filter(name => !env[name]);
  if (missing.length || env.MANAO_AI_OUTPUT_MODEL_AUTHORIZED !== 'true') throw new Error(`NOT_RUN: AI output requires this round's model authorization and explicit environment (${missing.join(', ')}). No browser/service/model action started.`);
  const baseURL = env.MANAO_AI_ACCEPTANCE_BASE_URL!;
  let url: URL;
  try { url = new URL(baseURL); } catch { throw new Error('NOT_RUN: BASE_URL must be an explicit HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('NOT_RUN: BASE_URL must be an explicit HTTP(S) origin without credentials/path/query/hash.');
  const projectId = env.MANAO_AI_ACCEPTANCE_PROJECT_ID!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) throw new Error('NOT_RUN: canonical project UUID required.');
  return { baseURL, projectId };
}
export type OutputHistoryItem = { seq: number; taskId: string | null; kind: string; contentIndex: number; textOffset: number; text: string; modelTruncated: boolean };
export function assembleOutputHistory(items: OutputHistoryItem[], taskId: string): { seq: number; contentIndex: number; kind: string; text: string; modelTruncated: boolean }[] {
  const blocks: { seq: number; contentIndex: number; kind: string; text: string; modelTruncated: boolean }[] = [];
  for (const item of items.filter(item => item.taskId === taskId && ['thinking', 'assistant'].includes(item.kind)).sort((a, b) => a.seq - b.seq || a.contentIndex - b.contentIndex || a.textOffset - b.textOffset)) {
    const last = blocks.at(-1);
    if (last && last.seq === item.seq && last.contentIndex === item.contentIndex && last.kind === item.kind) { last.text += item.text; last.modelTruncated ||= item.modelTruncated; }
    else blocks.push({ seq: item.seq, contentIndex: item.contentIndex, kind: item.kind, text: item.text, modelTruncated: item.modelTruncated });
  }
  return blocks;
}

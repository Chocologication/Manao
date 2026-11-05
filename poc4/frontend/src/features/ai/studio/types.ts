import { parseAgentTaskSnapshot, type AgentTaskSnapshot } from '@/contracts/agentTask';

export type StudioModel = { id: string; label: string; baseUrl: string; model: string; vision: boolean; tools: boolean; keyConfigured: boolean };
export type ModelInput = Omit<StudioModel, 'keyConfigured'> & { apiKey: string };
export type Conversation = { id: string; title: string; updatedAt: string };
export type Attachment = { id: string; name: string; mediaType: string; size: number; truncated: boolean };
export type Reference = { kind: 'file' | 'code' | 'logs'; path: string; text?: string };
export type Hunk = { id: string; start: number; before: string[]; after: string[] };
export type FileChange = { path: string; before: string | null; after: string; beforeSha256: string | null; hunks: Hunk[] };
export type ApplyInput = { requestId: string; hunkIds: string[]; expectedRevision: string };
export type Validation = { goal?: string; exitCode?: number | null; output?: string; cleanupConfirmed?: boolean; testReports?: { testClass: string; tests: number; failures: number; errors: number; skipped: number }[]; error?: unknown };
export type Application = { state?: 'APPLYING' | 'VALIDATING' | 'COMPLETED' | 'REJECTED' | 'VALIDATION_FAILED'; requestId?: string; hunkIds?: string[]; baseRevision?: number; workspaceRevision?: string; taskId?: string; error?: string; validation?: Validation };
export type Turn = {
  id: string; conversationId: string; version: number; mode: 'CHAT' | 'TASK'; applyPolicy: 'AUTO' | 'REVIEW'; modelId: string;
  prompt: string; reply: string; reasoning?: string; state: 'RUNNING' | 'STOPPING' | 'STOPPED' | 'ATTENTION' | 'COMPLETED' | 'REVIEW' | 'FAILED';
  expectedRevision: string; createdAt: string; error?: string; attachmentIds: string[]; attachments?: Attachment[]; references: Reference[];
  tools: { id: string; name: string; state: string; args?: string; result?: string }[];
  files: FileChange[]; taskId?: string; task?: AgentTaskSnapshot; application?: Application;
};
export type TurnInput = Pick<Turn, 'id' | 'prompt' | 'mode' | 'applyPolicy' | 'modelId' | 'expectedRevision' | 'attachmentIds' | 'references'>;
export const isActive = (turn: Turn) => ['RUNNING', 'STOPPING', 'ATTENTION'].includes(turn.state);
export function parseTurn(value: unknown): Turn {
  if (!value || typeof value !== 'object') throw new Error('Invalid assistant response');
  const t = value as Turn;
  if (typeof t.id !== 'string' || typeof t.conversationId !== 'string' || !Number.isSafeInteger(t.version) || t.version < 0
    || !['CHAT', 'TASK'].includes(t.mode) || !['AUTO', 'REVIEW'].includes(t.applyPolicy)
    || !['RUNNING', 'STOPPING', 'STOPPED', 'ATTENTION', 'COMPLETED', 'REVIEW', 'FAILED'].includes(t.state)
    || typeof t.prompt !== 'string' || typeof t.reply !== 'string' || !Array.isArray(t.tools) || !Array.isArray(t.files) || !Array.isArray(t.references) || !Array.isArray(t.attachmentIds)) throw new Error('Invalid assistant turn');
  for (const file of t.files) {
    if (typeof file.path !== 'string' || !Array.isArray(file.hunks) || file.hunks.length > 2000) throw new Error('Invalid assistant changes');
    for (const h of file.hunks) if (typeof h.id !== 'string' || !Number.isSafeInteger(h.start) || h.start < 0
      || !Array.isArray(h.before) || !Array.isArray(h.after) || [...h.before, ...h.after].some(line => typeof line !== 'string')) throw new Error('Invalid assistant hunk');
  }
  if (t.task) t.task = parseAgentTaskSnapshot(t.task);
  return t;
}
export function errorText(error: unknown): string {
  const code = (error as { body?: { code?: string } })?.body?.code;
  const messages: Record<string, string> = {
    WORKSPACE_REVISION_CONFLICT: '项目文件已变化，请重新生成变更方案。', AI_TASK_ACTIVE: '请先等待当前任务完成。',
    AI_CREDENTIALS_UNAVAILABLE: '模型凭据加密尚未配置，请设置后端 MANAO_AI_CREDENTIAL_KEY。', AI_VISION_UNSUPPORTED: '当前模型未启用图片支持，请切换模型。',
    AI_APPLY_MISMATCH: '上次变更尚未完成，请先检查应用结果。', AI_APPLY_INTERRUPTED: '变更任务已结束，请先检查已应用的文件。',
    AI_APPLY_CONFLICT: '应用变更时发现文件冲突，请检查上次应用结果和当前文件。', AI_BUSY: '服务繁忙，请稍后重试。',
    AI_MODEL_REJECTED: '模型服务拒绝请求，请检查 API 地址、密钥和模型。', AI_MODEL_DISCONNECTED: '模型连接中断，已保留收到的内容。',
    AI_MODEL_INCOMPLETE: '模型输出未完成，已保留收到的内容。', AI_MODEL_UNAVAILABLE: '模型服务暂不可用，请检查配置或稍后重试。',
    AI_WORKER_NOT_CONFIGURED: '任务服务尚未配置。', AI_MODEL_PROTOCOL: '模型服务返回的流格式不兼容。',
    AI_READ_ONLY: '聊天模式只支持读取项目内容，请切换到任务模式执行修改。', AI_STOPPED: '本次请求已停止。',
    AI_TOOL_BUDGET: '本次读取或工具调用已达上限，请缩小任务范围后重试。',
    AI_REVIEW_ISOLATED: '审阅模式仅支持读取文件和验证方案，请先应用变更再运行项目。',
    WORKSPACE_CONFLICT: '项目文件已变化，请重新生成变更方案。',
    NODE_RUNTIME_NOT_CONFIGURED: 'Node.js 运行环境尚未配置，请联系管理员。',
    RUN_ALREADY_ACTIVE: '请先停止项目运行，再应用代码变更。', PROJECT_BUSY: '项目正在处理其他操作，请稍后重试。',
    VALIDATION_ERROR: '请检查输入内容、模型地址和附件格式。', FILE_TOO_LARGE: '附件或代码变更超过大小限制。',
    PATH_FORBIDDEN: '该文件不在 AI 可读取范围内。', WORKSPACE_RECONCILIATION_REQUIRED: '文件写入结果尚未确认，请先检查上次操作，避免重复修改。',
  };
  return code && messages[code] || '操作未完成，请重试；已提交的任务会保留原请求。';
}

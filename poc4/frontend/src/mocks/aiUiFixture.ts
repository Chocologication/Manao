import { http, HttpResponse } from 'msw';
import type { ConversationView, HistoryItem } from '../contracts/agentConversation';
import type { AgentTaskSnapshot, AgentToolCallResult } from '../contracts/agentTask';
import { getWorkspaceRevision } from './fileFixtures';
import { resolveUserByAccessToken } from './state';
import { startRun, transitionRun } from './runState';

// AI_UI_VISUAL_FIXTURE_ONLY: fixed presentation data, never model acceptance.
const project = 'prj-alice-notebook';
const base = `/api/v1/projects/${project}`;
const taskId = 'ui-task-completed';
const firstId = 'ui-conversation-reading';
function conversation(conversationId: string, title: string, headSeq = 0): ConversationView {
  return { conversationId, title, headSeq, lastTaskId: headSeq ? taskId : null, activeTaskId: null,
    usage: { tokens: 2633, contextWindow: 1048576, percent: 0.251 }, compactRequestId: null,
    compactState: null, compactFailureCode: null, nextReasoningEffort: 'high' };
}
const first = conversation(firstId, '书籍接口与阅读排版', 18);
const second = conversation('ui-conversation-empty', '下一轮项目讨论');
const created: ConversationView[] = [];
const run = startRun(project, { expectedWorkspaceRevision: getWorkspaceRevision(project) });
if (!run.ok) throw new Error('Cannot seed existing mock Run');
const runId = run.value.run.id;
transitionRun(project, runId, { state: 'RUNNING' });
transitionRun(project, runId, { state: 'SUCCEEDED', terminationReason: 'BUILD_SUCCEEDED', exitCode: 0 });
const task: AgentTaskSnapshot = { taskId, conversationId: firstId, reasoningEffort: 'high', state: 'COMPLETED',
  workspaceRevision: getWorkspaceRevision(project), writesLocked: false, progress: [],
  changedPaths: ['src/main/java/example/BookController.java'], summary: '固定 UI 历史，仅验证展示。', failureCode: null };
const rich = '# 书籍接口整理\n\n已保留项目已有的运行与上下文能力。**下面是固定 UI 验收内容**。\n\n| 接口 | 说明 | 长字段 |\n| --- | --- | --- |\n| GET /books | 查询书籍 | ' + '字段'.repeat(55) + ' |\n| POST /books | 新建书籍 | title / author |\n\n```java\nString endpoint = "' + 'books/'.repeat(45) + '";\nSystem.out.println(endpoint);\n```\n\n- Markdown 列表\n- 表格与代码应局部横向滚动\n';
const history: HistoryItem[] = Array.from({ length: 14 }, (_, i) => ({ seq: i + 1, taskId,
  kind: i % 2 ? 'assistant' : 'user', text: i % 2 ? `## 第 ${i} 轮说明\n\n${'检查现有代码、运行记录和用户要求，保持原有业务契约。'.repeat(4)}` : `请核对第 ${i + 1} 项接口，保留错误状态与上下文说明。`,
  toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false }));
history.push(
  { seq: 15, taskId, kind: 'thinking', text: '先检查接口契约，再核对持久化与运行结果。此文本为固定展示夹具。', toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false },
  { seq: 16, taskId, kind: 'assistant', text: rich, toolCallId: null, textOffset: 0, contentIndex: 0, modelTruncated: false },
  { seq: 17, taskId, kind: 'tool_result', text: 'read_file 已完成', toolCallId: 'ui-read', textOffset: 0, contentIndex: 0, modelTruncated: false },
  { seq: 18, taskId, kind: 'tool_result', text: 'app_http_get 已完成', toolCallId: 'ui-http', textOffset: 0, contentIndex: 0, modelTruncated: false },
);
function allowed(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? null;
  return resolveUserByAccessToken(token)?.id === 'usr-alice';
}
const missing = () => HttpResponse.json({ code: 'ENTRY_NOT_FOUND', message: 'UI fixture entry not found', traceId: 'ai-ui-fixture' }, { status: 404 });
export const aiUiHandlers = [
  http.get(`${base}/conversations`, ({ request }) => allowed(request) ? HttpResponse.json(new URL(request.url).searchParams.has('before') ? { items: [second], nextCursor: null } : { items: [...created, first], nextCursor: 'ui-page-2' }) : undefined),
  http.post(`${base}/conversations`, async ({ request }) => {
    if (!allowed(request)) return undefined;
    const { conversationId } = await request.json() as { conversationId: string };
    const item = conversation(conversationId, '新建空会话'); created.unshift(item); return HttpResponse.json(item);
  }),
  http.get(`${base}/conversations/:conversationId`, ({ request, params }) => {
    if (!allowed(request)) return undefined;
    const item = [first, second, ...created].find(c => c.conversationId === params.conversationId);
    return item ? HttpResponse.json(item) : missing();
  }),
  http.get(`${base}/conversations/:conversationId/entries`, ({ request, params }) => allowed(request) ? HttpResponse.json({ items: params.conversationId === firstId ? history.filter(item => item.seq < Number(new URL(request.url).searchParams.get('beforeSeq') ?? 19)) : [], nextBeforeSeq: null, nextBeforeOffset: null }) : undefined),
  http.get(`${base}/agent-tasks/current`, ({ request }) => allowed(request) ? missing() : undefined),
  http.get(`${base}/agent-tasks/${taskId}`, ({ request }) => allowed(request) ? HttpResponse.json(task) : undefined),
  http.get(`${base}/agent-tasks/${taskId}/tools/:toolCallId`, ({ request, params }) => {
    if (!allowed(request)) return undefined;
    const result: AgentToolCallResult = params.toolCallId === 'ui-read'
      ? { toolCallId: 'ui-read', toolName: 'read_file', data: { path: 'README.md', content: '# Fixed UI fixture', sha256: 'a'.repeat(64) } }
      : { toolCallId: 'ui-http', toolName: 'app_http_get', data: { kind: 'app_http_get', runId, path: '/books', statusCode: 200, contentType: 'application/json', body: '[{"title":"UI fixture"}]', truncated: false, error: null } };
    return HttpResponse.json(result);
  }),
];

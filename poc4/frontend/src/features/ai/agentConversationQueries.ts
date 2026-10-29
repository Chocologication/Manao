import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getAgentConversation, getConversationHistory, listAgentConversations } from '@/api/agentConversationApi';
import { getAgentTask } from '@/api/agentTaskApi';
import type { HistoryCursor } from '@/contracts/agentConversation';
export const conversationKeys = {
  all: (userId: string, projectId: string) => ['agent-conversations', userId, projectId] as const,
  list: (userId: string, projectId: string) => [...conversationKeys.all(userId, projectId), 'list'] as const,
  detail: (userId: string, projectId: string, id: string) => [...conversationKeys.all(userId, projectId), id, 'detail'] as const,
  history: (userId: string, projectId: string, id: string, head: number) => [...conversationKeys.all(userId, projectId), id, 'history', head] as const,
  task: (userId: string, projectId: string, id: string, taskId: string) => [...conversationKeys.all(userId, projectId), id, 'task', taskId] as const,
};
export function useConversationList(userId: string, projectId: string) {
  return useInfiniteQuery({ queryKey: conversationKeys.list(userId, projectId), queryFn: ({ pageParam, signal }) => listAgentConversations(projectId, pageParam, signal), initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor ?? undefined, enabled: userId !== '', retry: false, refetchOnWindowFocus: false, refetchInterval: 2_000 });
}
export function useConversationDetail(userId: string, projectId: string, id: string | null) {
  return useQuery({ queryKey: conversationKeys.detail(userId, projectId, id ?? ''), queryFn: ({ signal }) => getAgentConversation(projectId, id!, signal), enabled: id !== null && userId !== '', retry: false, refetchOnWindowFocus: false, refetchInterval: 2_000 });
}
export function useConversationHistory({ userId, projectId, conversationId, headSeq, enabled = true }: { userId: string; projectId: string; conversationId: string; headSeq: number; enabled?: boolean }) {
  return useInfiniteQuery({ queryKey: conversationKeys.history(userId, projectId, conversationId, headSeq), queryFn: ({ pageParam, signal }) => getConversationHistory(projectId, conversationId, pageParam, signal), initialPageParam: { beforeSeq: headSeq + 1, beforeOffset: null } as HistoryCursor, getNextPageParam: page => page.nextBeforeSeq === null ? undefined : { beforeSeq: page.nextBeforeSeq, beforeOffset: page.nextBeforeOffset }, enabled: enabled && userId !== '', retry: false, refetchOnWindowFocus: false });
}
export function useConversationTask(userId: string, projectId: string, id: string | null, taskId: string | null) {
  return useQuery({ queryKey: conversationKeys.task(userId, projectId, id ?? '', taskId ?? ''), queryFn: () => getAgentTask(projectId, taskId!), enabled: id !== null && taskId !== null && userId !== '', retry: false, refetchOnWindowFocus: false, refetchInterval: 2_000 });
}

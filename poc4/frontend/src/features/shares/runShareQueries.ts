import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRunSharePreview, listMyRunShares, revokeRunShare } from '../../api/runShareApi';
import { authSession } from '../../app/appRuntime';
import { useAuth } from '../auth/AuthProvider';
import type { AuthSnapshot } from '../auth/authSession';

const sessionIds = new WeakMap<object, number>();
let nextSessionId = 0;
export function shareSessionId(session: AuthSnapshot): number {
  let id = sessionIds.get(session); if (id === undefined) { id = ++nextSessionId; sessionIds.set(session, id); } return id;
}
export const runShareKeys = {
  owner: (ownerId: string) => ['run-shares', ownerId] as const,
  list: (ownerId: string, sessionId: number) => ['run-shares', ownerId, sessionId, 'list'] as const,
  preview: (ownerId: string, sessionId: number, projectId: string, runId: string) => ['run-shares', ownerId, sessionId, 'preview', projectId, runId] as const,
};
function assertSession(session: AuthSnapshot) { if (session.status !== 'authenticated' || session !== authSession.getSnapshot()) throw new Error('Share session changed'); }
export function useRunSharePreview(projectId: string, runId: string) {
  const { snapshot } = useAuth(); const ownerId = snapshot.status === 'authenticated' ? snapshot.user.id : '';
  return useQuery({ queryKey: runShareKeys.preview(ownerId, shareSessionId(snapshot), projectId, runId), enabled: snapshot.status === 'authenticated', retry: false, gcTime: 0, refetchOnWindowFocus: false, queryFn: async ({ signal }) => { const result = await getRunSharePreview(projectId, runId, signal); assertSession(snapshot); return result; } });
}
export function useMyRunShares() {
  const { snapshot } = useAuth(); const ownerId = snapshot.status === 'authenticated' ? snapshot.user.id : '';
  return useInfiniteQuery({ queryKey: runShareKeys.list(ownerId, shareSessionId(snapshot)), enabled: snapshot.status === 'authenticated', initialPageParam: undefined as string | undefined, retry: false, refetchOnWindowFocus: false, queryFn: async ({ pageParam, signal }) => { const result = await listMyRunShares(pageParam, signal); assertSession(snapshot); return result; }, getNextPageParam: (page) => page.nextCursor ?? undefined });
}
export function useRevokeRunShare() {
  const queryClient = useQueryClient();
  return useMutation({ retry: false, mutationFn: async (id: string) => { const session = authSession.getSnapshot(); assertSession(session); await revokeRunShare(id); assertSession(session); return session; }, onSuccess: (session) => { if (session.status === 'authenticated' && session === authSession.getSnapshot()) void queryClient.invalidateQueries({ queryKey: runShareKeys.owner(session.user.id) }); } });
}

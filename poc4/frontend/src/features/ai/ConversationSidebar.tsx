import { Button } from '@/components/ui/button';
import type { ConversationView } from '@/contracts/agentConversation';

type ConversationSidebarProps = {
  items: readonly Pick<ConversationView, 'conversationId' | 'title' | 'activeTaskId'>[];
  selectedId: string | null;
  creating: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLoadMore: () => void;
};
export function ConversationSidebar({ items, selectedId, creating, hasMore, loadingMore, onSelect, onCreate, onLoadMore }: ConversationSidebarProps) {
  return <nav aria-label="会话列表" className="manao-ai-sidebar">
    <Button size="sm" disabled={creating} onClick={onCreate}>新建会话</Button>
    <div className="manao-ai-sidebar-list">
      {items.map(item => <Button key={item.conversationId} size="sm" variant="outline" aria-pressed={selectedId === item.conversationId} onClick={() => onSelect(item.conversationId)}>
        <span className="manao-ai-sidebar-title">{item.title}</span>
        {item.activeTaskId ? <span className="text-xs text-muted-foreground">运行中</span> : null}
      </Button>)}
      {hasMore ? <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>更多会话</Button> : null}
    </div>
  </nav>;
}
